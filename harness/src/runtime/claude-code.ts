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
  /** Model to use (e.g., "claude-opus-5"). If omitted, uses Claude Code default. */
  model?: string;
  /**
   * Reasoning effort level (low | medium | high | xhigh | max). If omitted,
   * uses the model's default effort. If the model doesn't support the given
   * level, Claude Code falls back to the highest supported level at or below it.
   */
  effort?: string;
  /** Timeout in ms. Defaults to 10 minutes. */
  timeoutMs?: number;
  /**
   * How long (ms) the CLI waits in print mode for still-running background
   * Bash tasks to finish before terminating them. Maps to the CLI's
   * CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS env var. `0` waits indefinitely.
   * Defaults to `timeoutMs`, so background tasks get the full process budget
   * instead of the CLI's built-in 600s ceiling.
   */
  bgWaitCeilingMs?: number;
}

export class ClaudeCodeRuntime implements AgentRuntime {
  readonly name = "claude-code";
  private binary: string;
  private model?: string;
  private effort?: string;
  private timeoutMs: number;
  private bgWaitCeilingMs: number;

  constructor(options: ClaudeCodeRuntimeOptions = {}) {
    this.binary = options.claudeBinary ?? "claude";
    this.model = options.model;
    this.effort = options.effort;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.bgWaitCeilingMs = options.bgWaitCeilingMs ?? this.timeoutMs;
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

      const env = this.buildEnv(input);
      const stdout = await this.spawn(args, input.workingDirectory, env);
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
      // Only the servers the harness mounts via --mcp-config. Without this the
      // CLI also loads the host's own MCP servers — including claude.ai
      // connectors (e.g. Google Drive) tied to the logged-in account — which
      // bypass the capability/permission policy entirely.
      "--strict-mcp-config",
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

    if (this.effort) {
      args.push("--effort", this.effort);
    }

    if (input.enableChrome) {
      args.push("--chrome");
    }

    if (input.disableBuiltinTools) {
      // Empty tool list disables all built-in tools; MCP tools (mounted via
      // --mcp-config) are governed separately and unaffected.
      args.push("--tools", "");
    }

    if (input.additionalArgs) {
      args.push(...input.additionalArgs);
    }

    return args;
  }

  private buildEnv(input: AgentRuntimeInput): Record<string, string> {
    return {
      ...input.additionalEnv,
      // Let background Bash tasks run for the full process budget instead of
      // the CLI's built-in 600s ceiling before print mode terminates them.
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(this.bgWaitCeilingMs),
      HARNESS_MAX_TURNS: String(input.maxTurns),
      HARNESS_ROOT: input.harnessRoot ?? "",
      // Timestamp used by turn-limit-warning hook to count only turns from
      // the current run, not the entire session history on resume.
      HARNESS_RUN_START: new Date().toISOString(),
    };
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
