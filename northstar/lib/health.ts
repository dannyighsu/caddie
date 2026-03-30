/**
 * Health Checks
 *
 * Pre-flight verification of MCP capabilities and other dependencies.
 * Spawns each MCP server briefly and sends an initialize handshake.
 */

import { spawn } from "child_process";
import { resolve } from "path";
import { readdir, readFile } from "fs/promises";

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
  type: "mcp" | "flag";
  status: "ok" | "error" | "skipped";
  message?: string;
  durationMs?: number;
}

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g;

function resolveEnvVars(value: string): string {
  return value.replace(ENV_VAR_PATTERN, (_, varName) => {
    return process.env[varName] ?? "";
  });
}

/**
 * Test an MCP server by spawning it and sending an initialize message.
 * Returns within timeoutMs whether the server responded.
 */
async function checkMcpServer(
  def: CapabilityDef,
  timeoutMs = 30000
): Promise<HealthCheckResult> {
  if (!def.server) {
    return { name: def.name, type: "flag", status: "ok", message: "Flag-only (no server to check)" };
  }

  const start = Date.now();
  const command = resolveEnvVars(def.server.command);
  const args = def.server.args.map(resolveEnvVars);

  // Build env
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

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      // Look for a valid JSON-RPC response
      if (stdout.includes('"jsonrpc"') && stdout.includes('"result"')) {
        proc.kill();
        settle({
          name: def.name,
          type: "mcp",
          status: "ok",
          durationMs: Date.now() - start,
        });
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("error", (err) => {
      settle({
        name: def.name,
        type: "mcp",
        status: "error",
        message: `Failed to spawn: ${err.message}`,
        durationMs: Date.now() - start,
      });
    });

    proc.on("exit", (code) => {
      if (!settled) {
        settle({
          name: def.name,
          type: "mcp",
          status: code === 0 ? "ok" : "error",
          message: code !== 0 ? `Exited with code ${code}` : undefined,
          durationMs: Date.now() - start,
        });
      }
    });

    // Send MCP initialize request (raw JSON line — no Content-Length framing)
    const initMsg = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "northstar-health-check", version: "1.0" },
      },
    });

    proc.stdin.write(initMsg + "\n");

    // Timeout
    setTimeout(() => {
      proc.kill();
      const debug = stderr ? `stderr: ${stderr.trim().substring(0, 150)}` :
                    stdout ? `stdout: ${stdout.trim().substring(0, 150)}` :
                    "no output";
      settle({
        name: def.name,
        type: "mcp",
        status: "error",
        message: `Timeout after ${timeoutMs}ms (${debug})`,
        durationMs: timeoutMs,
      });
    }, timeoutMs);
  });
}

/**
 * Run health checks on all capabilities.
 */
export async function checkAllCapabilities(): Promise<HealthCheckResult[]> {
  // Use same repo root resolution as lib/harness.ts
  const repoRoot = resolve(process.cwd(), "..");
  const capabilitiesDir = resolve(repoRoot, "harness", "capabilities");
  const results: HealthCheckResult[] = [];

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
          `[Health] ${result.name}: ${result.status}${result.message ? ` — ${result.message}` : ""} (${result.durationMs ?? 0}ms)`
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

  return results;
}
