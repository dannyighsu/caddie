/**
 * MCP Capability Resolver
 *
 * Reads capability definition files (JSON) and resolves them into
 * MCPServerConfig objects ready to pass to the agent runtime.
 * Environment variable references (${VAR_NAME}) are resolved from process.env.
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import type { MCPServerConfig } from "../runtime/types.js";

export interface CapabilityDefinition {
  name: string;
  description?: string;
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
function resolveEnvVars(value: string, missingVars: Set<string>): string {
  return value.replace(ENV_VAR_PATTERN, (_, varName) => {
    const resolved = process.env[varName];
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
function resolveEnvRecord(record: Record<string, string>, missingVars: Set<string>): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    resolved[key] = resolveEnvVars(value, missingVars);
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

export interface ResolveResult {
  /** MCP servers to pass to the runtime. */
  servers: Record<string, MCPServerConfig>;
  /** Flag-only capabilities (no MCP server, e.g., chrome). */
  flags: string[];
  /** Warnings about missing env vars or failed loads. */
  warnings: string[];
}

/**
 * Resolve a list of capability names into MCP server configs and flags.
 *
 * @param capabilityNames - Names matching JSON files in the capabilities directory
 * @param capabilitiesDir - Directory containing capability JSON files
 */
export async function resolveCapabilities(
  capabilityNames: string[],
  capabilitiesDir: string
): Promise<ResolveResult> {
  const servers: Record<string, MCPServerConfig> = {};
  const flags: string[] = [];
  const warnings: string[] = [];

  for (const name of capabilityNames) {
    try {
      const def = await loadCapability(capabilitiesDir, name);

      // Flag-only capability (no server config)
      if (!def.server) {
        flags.push(def.name);
        continue;
      }

      const missingVars = new Set<string>();
      servers[def.name] = {
        command: resolveEnvVars(def.server.command, missingVars),
        args: def.server.args.map((a) => resolveEnvVars(a, missingVars)),
        env: def.server.env ? resolveEnvRecord(def.server.env, missingVars) : undefined,
      };

      if (missingVars.size > 0) {
        const vars = Array.from(missingVars).join(", ");
        const msg = `Capability "${name}" has unset env vars: ${vars}`;
        warnings.push(msg);
        console.warn(`[MCP Resolver] ${msg}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const msg = `Failed to load capability "${name}": ${message}`;
      warnings.push(msg);
      console.error(`[MCP Resolver] ${msg}`);
    }
  }

  return { servers, flags, warnings };
}
