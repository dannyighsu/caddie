/**
 * Health Checks
 *
 * Pre-flight verification of MCP capabilities and other dependencies.
 * Verifies each MCP server command is resolvable and starts without crashing.
 */

import { spawn } from "child_process";
import { resolve } from "path";
import { readdir, readFile, access } from "fs/promises";
import { workspace } from "./harness";
import { indexStatus } from "./workspace-index";

interface CapabilityDef {
  name: string;
  description?: string;
  server?: {
    command: string;
    args: string[];
    env?: Record<string, string>;
  };
}

export interface HealthCheckResult {
  name: string;
  type: "mcp" | "flag" | "index";
  status: "ok" | "error" | "skipped";
  message?: string;
}

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

/**
 * Per-agent values the launcher substitutes at run time. Health checks use the
 * default agent's, so a capability like local-rag starts against a real
 * workspace instead of an empty path.
 */
let runtimeVars: Record<string, string> = {};

function resolveEnvVars(value: string, missing?: Set<string>): string {
  return value.replace(ENV_VAR_PATTERN, (_, varName) => {
    const v = runtimeVars[varName] ?? process.env[varName];
    if (v === undefined) missing?.add(varName);
    return v ?? "";
  });
}

/**
 * Check an MCP server by verifying its command is resolvable and it starts
 * without immediately crashing. Does not do a full MCP handshake — that's
 * too slow/fragile for servers that open browsers or resolve dependencies.
 */
async function checkMcpServer(def: CapabilityDef): Promise<HealthCheckResult> {
  if (!def.server) {
    return { name: def.name, type: "flag", status: "ok", message: "Flag-only" };
  }

  // Mirror the launcher: a capability with unset variables isn't mounted, so
  // don't start it with blanks either (it may treat "" as a path).
  const missing = new Set<string>();
  for (const v of [def.server.command, ...def.server.args, ...Object.values(def.server.env ?? {})]) {
    resolveEnvVars(v, missing);
  }
  if (missing.size > 0) {
    return { name: def.name, type: "mcp", status: "skipped", message: `Not configured — unset: ${[...missing].join(", ")}` };
  }

  const command = resolveEnvVars(def.server.command);

  // For absolute paths, verify the file exists
  if (command.startsWith("/")) {
    try {
      await access(command);
    } catch {
      return { name: def.name, type: "mcp", status: "error", message: `Command not found: ${command}` };
    }
  }

  // Spawn and give it a moment — if it crashes immediately, that's a problem.
  // If it's still alive after 500ms, it's healthy enough.
  const repoRoot = resolve(process.cwd(), "..");
  const capabilitiesDir = resolve(repoRoot, "harness", "capabilities");
  const args = def.server.args.map((a) => {
    const resolved = resolveEnvVars(a);
    if (resolved.startsWith("./") || resolved.startsWith("../")) {
      return resolve(capabilitiesDir, resolved);
    }
    return resolved;
  });
  const env: Record<string, string> = { ...process.env as Record<string, string> };
  if (def.server.env) {
    for (const [key, value] of Object.entries(def.server.env)) {
      env[key] = resolveEnvVars(value);
    }
  }

  return new Promise<HealthCheckResult>((resolvePromise) => {
    let settled = false;
    const settle = (result: HealthCheckResult) => {
      if (!settled) {
        settled = true;
        resolvePromise(result);
      }
    };

    const proc = spawn(command, args, {
      env: env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      settle({ name: def.name, type: "mcp", status: "error", message: `Failed to spawn: ${err.message}` });
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settle({
          name: def.name,
          type: "mcp",
          status: "error",
          message: `Exited with code ${code}${stderr ? ` (${stderr.trim().substring(0, 200)})` : ""}`,
        });
      }
    });

    // If still alive after 500ms, it's good — kill it and report ok
    setTimeout(() => {
      if (!settled) {
        proc.kill();
        settle({ name: def.name, type: "mcp", status: "ok" });
      }
    }, 500);
  });
}

/**
 * Run health checks on all capabilities.
 */
export async function checkAllCapabilities(): Promise<HealthCheckResult[]> {
  const repoRoot = resolve(process.cwd(), "..");
  const harnessRoot = resolve(repoRoot, "harness");
  const capabilitiesDir = resolve(harnessRoot, "capabilities");

  // Ensure HARNESS_ROOT is available for env var interpolation in capability server args
  process.env.HARNESS_ROOT = harnessRoot;
  const results: HealthCheckResult[] = [];

  runtimeVars = { CADDIE_WORKSPACE: workspace };

  try {
    const entries = await readdir(capabilitiesDir);
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const content = await readFile(resolve(capabilitiesDir, entry), "utf-8");
        const def = JSON.parse(content) as CapabilityDef;
        const result = await checkMcpServer(def);
        results.push(result);
        console.log(
          `[Health] ${result.name}: ${result.status}${result.message ? ` — ${result.message}` : ""}`
        );
      } catch (err) {
        results.push({
          name: entry.replace(".json", ""),
          type: "mcp",
          status: "error",
          message: `Failed to load: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  } catch {
    console.warn("[Health] Could not read capabilities directory");
  }

  results.push(indexHealth());

  return results;
}

/** The workspace search index: whether it's on, current, and healthy. */
function indexHealth(): HealthCheckResult {
  const s = indexStatus();
  const name = "workspace-index";
  if (!s.enabled) {
    return { name, type: "index", status: "skipped", message: "LOCAL_RAG_ENTRY not set — see make rag-setup" };
  }
  if (s.rebuildRequired) {
    return { name, type: "index", status: "error", message: `Rebuild required (make rag-rebuild): ${s.rebuildRequired}` };
  }
  if (s.lastError) return { name, type: "index", status: "error", message: s.lastError };
  const synced = s.lastSync ? `last sync ${s.lastSync}` : s.syncing ? "first sync in progress" : "not synced yet";
  const failing = s.failures ? `, ${s.failures} file(s) failing` : "";
  return { name, type: "index", status: "ok", message: `${s.indexedFiles} files indexed, ${synced}${failing}` };
}
