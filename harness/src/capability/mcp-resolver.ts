/**
 * MCP Capability Resolver
 *
 * Reads capability definition files (JSON) and resolves them into
 * MCPServerConfig objects ready to pass to the agent runtime.
 * Environment variable references (${VAR_NAME}) are resolved from process.env.
 *
 * A capability with an unresolved reference is skipped rather than mounted with
 * a blank value, so a missing credential costs you that one capability instead
 * of producing tools that fail at first use. Nothing here fails a run.
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import type { MCPServerConfig } from "../runtime/types.js";

export interface CapabilityDefinition {
  name: string;
  description?: string;
  /**
   * Tools this capability's server exposes that a run must never call, by the
   * server's own tool name (e.g. `delete_file`). Used when a third-party server
   * bundles write tools alongside the reads we want — the tools are removed
   * from the run entirely rather than left to instructions.
   */
  disallowedTools?: string[];
  /** MCP server config. Omit for flag-only capabilities (e.g., chrome). */
  server?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Resolve ${ENV_VAR} references in a string from process.env.
 * Collects names of missing variables into the provided set.
 */
function resolveEnvVars(
  value: string,
  missingVars: Set<string>,
  provided: Record<string, string> = {}
): string {
  return value.replace(ENV_VAR_PATTERN, (_, varName) => {
    const resolved = provided[varName] ?? process.env[varName];
    if (resolved === undefined) {
      missingVars.add(varName);
      return "";
    }
    return resolved;
  });
}

/**
 * Resolve env vars in all string values of a record.
 */
function resolveEnvRecord(
  record: Record<string, string>,
  missingVars: Set<string>,
  provided: Record<string, string> = {}
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = resolveEnvVars(value, missingVars, provided);
  }
  return resolved;
}

/**
 * Load a single capability definition from a JSON file.
 */
async function loadCapability(
  capabilitiesDir: string,
  name: string
): Promise<CapabilityDefinition> {
  const filePath = resolve(capabilitiesDir, `${name}.json`);
  const content = await readFile(filePath, "utf-8");
  return JSON.parse(content) as CapabilityDefinition;
}

/** A capability left unmounted because its configuration is incomplete. */
export interface SkippedCapability {
  name: string;
  /** The `${VAR}` references that resolved to nothing. */
  missingVars: string[];
}

export interface ResolveResult {
  /** MCP servers to pass to the runtime. */
  servers: Record<string, MCPServerConfig>;
  /** Flag-only capabilities (no MCP server, e.g., chrome). */
  flags: string[];
  /**
   * Fully qualified tool names (`mcp__<server>__<tool>`) to remove from the run,
   * from the `disallowedTools` of every capability that was actually mounted.
   */
  disallowedTools: string[];
  /** Warnings about missing env vars or failed loads. */
  warnings: string[];
  /**
   * Capabilities skipped for missing credentials. The run still proceeds — an
   * unconfigured capability is simply absent, never a broken mount.
   */
  skipped: SkippedCapability[];
}

/**
 * Resolve a list of capability names into MCP server configs and flags.
 *
 * @param capabilityNames - Names matching JSON files in the capabilities directory
 * @param capabilitiesDir - Directory containing capability JSON files
 */
export async function resolveCapabilities(
  capabilityNames: string[],
  capabilitiesDir: string,
  /**
   * Substitutions the caller knows, checked before process.env. Used for paths
   * the harness computes rather than the operator configures (HARNESS_ROOT), so
   * a capability is never skipped for something that was never user config.
   */
  provided: Record<string, string> = {}
): Promise<ResolveResult> {
  const servers: Record<string, MCPServerConfig> = {};
  const flags: string[] = [];
  const disallowedTools: string[] = [];
  const warnings: string[] = [];
  const skipped: SkippedCapability[] = [];

  for (const name of capabilityNames) {
    try {
      const def = await loadCapability(capabilitiesDir, name);

      // Flag-only capability (no server config)
      if (!def.server) {
        flags.push(def.name);
        continue;
      }

      const missingVars = new Set<string>();
      const server = {
        command: resolveEnvVars(def.server.command, missingVars, provided),
        args: def.server.args.map((a) => {
          const resolved = resolveEnvVars(a, missingVars, provided);
          // Resolve relative paths against the capabilities directory
          if (resolved.startsWith("./") || resolved.startsWith("../")) {
            return resolve(capabilitiesDir, resolved);
          }
          return resolved;
        }),
        env: def.server.env ? resolveEnvRecord(def.server.env, missingVars, provided) : undefined,
      };

      // A capability whose credentials are unset is NOT mounted. Mounting it
      // anyway would hand the agent tools that authenticate with an empty
      // string — the failure then surfaces mid-run as a confusing tool error,
      // and the agent may burn turns retrying it. An unconfigured optional
      // capability should look like an absent one: the run proceeds without it.
      if (missingVars.size > 0) {
        const vars = Array.from(missingVars).join(", ");
        const msg =
          `Capability "${name}" NOT mounted — unset env vars: ${vars}. ` +
          `Set them (see portal/.env.example) or drop "${name}" from the agent's capabilities.`;
        skipped.push({ name, missingVars: Array.from(missingVars) });
        warnings.push(msg);
        console.warn(`[MCP Resolver] ${msg}`);
        continue;
      }

      servers[def.name] = server;
      for (const tool of def.disallowedTools ?? []) {
        disallowedTools.push(`mcp__${def.name}__${tool}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const msg = `Failed to load capability "${name}": ${message}`;
      warnings.push(msg);
      console.error(`[MCP Resolver] ${msg}`);
    }
  }

  return { servers, flags, disallowedTools, warnings, skipped };
}
