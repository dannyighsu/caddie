/**
 * Claude Code CLI Runtime
 *
 * Invokes `claude` CLI in non-interactive mode (`-p`) with structured output.
 * Authenticates via the locally configured Claude Code OAuth token.
 */

import { spawn } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { v4 as uuid } from "uuid";
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeOutput,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

export interface ClaudeCodeRuntimeOptions {
  /** Path to the `claude` binary. Defaults to "claude" (on PATH). */
  claudeBinary?: string;
  /** Model to use (e.g., "claude-sonnet-4-5"). If omitted, uses Claude Code default. */
  model?: string;
  /** Timeout in ms. Defaults to 10 minutes. */
  timeoutMs?: number;
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name = "claude-code";
  private binary: string;
  private model?: string;
  private timeoutMs: number;

  constructor(options: ClaudeCodeRuntimeOptions = {}) {
    this.binary = options.claudeBinary ?? "claude";
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async execute(input: AgentRuntimeInput): Promise<AgentRuntimeOutput> {
    const args = this.buildArgs(input);
    let mcpConfigPath: string | null = null;

    try {
      // If MCP servers are configured, write a temp config file
      if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
        mcpConfigPath = join(tmpdir(), `harness-mcp-${uuid()}.json`);
        const mcpConfig: Record<string, unknown> = {};
        for (const [name, config] of Object.entries(input.mcpServers)) {
          mcpConfig[name] = {
            command: config.command,
            args: config.args,
            env: config.env,
          };
        }
        await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: mcpConfig }));
        args.push("--mcp-config", mcpConfigPath);
      }

      const stdout = await this.spawn(args, input.workingDirectory, input.additionalEnv);
      return this.parseOutput(stdout);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ClaudeCodeRuntime] Execution failed: ${message}`);
      return {
        output: null,
        sessionId: "",
        rawText: "",
        error: message,
      };
    } finally {
      if (mcpConfigPath) {
        await unlink(mcpConfigPath).catch(() => {});
      }
    }
  }

  private buildArgs(input: AgentRuntimeInput): string[] {
    const args: string[] = [
      "-p", input.prompt,
      "--output-format", "json",
      "--max-turns", String(input.maxTurns),
      "--dangerously-skip-permissions",
    ];

    if (input.outputSchema) {
      args.push("--json-schema", JSON.stringify(input.outputSchema));
    }

    if (input.sessionId) {
      args.push("--resume", input.sessionId);
    }

    if (this.model) {
      args.push("--model", this.model);
    }

    if (input.enableChrome) {
      args.push("--chrome");
    }

    if (input.additionalArgs) {
      args.push(...input.additionalArgs);
    }

    return args;
  }

  private spawn(args: string[], cwd: string, additionalEnv?: Record<string, string>): Promise<string> {
    // Log the command being run (redact prompt content for brevity)
    const logArgs = args.map((a, i) =>
      args[i - 1] === "-p" && a.length > 100 ? `"${a.substring(0, 100)}..."` : a
    );
    console.log(`[ClaudeCodeRuntime] Spawning: ${this.binary} ${logArgs.join(" ")}`);
    console.log(`[ClaudeCodeRuntime] cwd: ${cwd}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: typeof resolve | typeof reject, value: string | Error) => {
        if (!settled) {
          settled = true;
          (fn as (v: string | Error) => void)(value);
        }
      };

      const proc = spawn(this.binary, args, {
        cwd,
        env: { ...process.env, CLAUDECODE: undefined, ...additionalEnv },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Close stdin immediately to prevent "no stdin data" warning
      proc.stdin.end();

      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(`[claude] ${text}`);
      });

      // Timeout
      const timer = setTimeout(() => {
        proc.kill();
        settle(reject, new Error(`claude process timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      proc.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          const detail = stderr.trim().slice(-500) || stdout.trim().slice(-500) || "no output";
          settle(reject, new Error(`claude process exited with code ${code}: ${detail}`));
        } else {
          settle(resolve, stdout);
        }
      });

      proc.on("error", (err) => {
        clearTimeout(timer);
        settle(reject, new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  }

  private parseOutput(stdout: string): AgentRuntimeOutput {
    try {
      const parsed = JSON.parse(stdout);
      return {
        output: parsed.structured_output ?? null,
        sessionId: parsed.session_id ?? "",
        rawText: parsed.result ?? "",
        error: parsed.is_error ? (parsed.result ?? "Unknown error") : undefined,
        usage: parsed.usage ? {
          ...parsed.usage,
          totalCostUsd: parsed.total_cost_usd,
          durationMs: parsed.duration_ms,
          numTurns: parsed.num_turns,
        } : undefined,
      };
    } catch {
      console.warn("[ClaudeCodeRuntime] Failed to parse JSON output, treating as raw text");
      return {
        output: null,
        sessionId: "",
        rawText: stdout,
        error: "Failed to parse structured output from runtime",
      };
    }
  }
}

export { DEFAULT_TIMEOUT_MS };
