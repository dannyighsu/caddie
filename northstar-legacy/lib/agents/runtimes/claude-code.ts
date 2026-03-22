/**
 * Claude Code CLI Runtime
 *
 * Invokes `claude` CLI in non-interactive mode (`-p`) with structured output.
 * Authenticates via the locally configured Claude Code OAuth token.
 */

import { execFile } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { v4 as uuid } from "uuid";
import type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeOutput,
} from "../runtime";

/** Timeout defaults in ms */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const XMANAGER_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

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
        mcpConfigPath = join(tmpdir(), `northstar-mcp-${uuid()}.json`);
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

      const stdout = await this.spawn(args, input.workingDirectory);
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
      // Clean up temp MCP config
      if (mcpConfigPath) {
        await unlink(mcpConfigPath).catch(() => {});
      }
    }
  }

  private buildArgs(input: AgentRuntimeInput): string[] {
    const args: string[] = [
      "-p", input.prompt,
      "--output-format", "json",
      "--json-schema", JSON.stringify(input.outputSchema),
      "--max-turns", String(input.maxTurns),
    ];

    if (input.sessionId) {
      args.push("--resume", input.sessionId);
    }

    if (this.model) {
      args.push("--model", this.model);
    }

    if (input.enableChrome) {
      args.push("--chrome");
    }

    return args;
  }

  private spawn(args: string[], cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = execFile(
        this.binary,
        args,
        {
          cwd,
          timeout: this.timeoutMs,
          maxBuffer: 50 * 1024 * 1024, // 50MB for large outputs
          env: process.env,
        },
        (error, stdout, stderr) => {
          if (stderr) {
            console.error(`[ClaudeCodeRuntime] stderr: ${stderr.substring(0, 500)}`);
          }
          if (error) {
            reject(new Error(`claude process failed: ${error.message}`));
            return;
          }
          resolve(stdout);
        }
      );

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
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
      };
    } catch {
      // If JSON parsing fails, treat as raw text response
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

export { DEFAULT_TIMEOUT_MS, XMANAGER_TIMEOUT_MS };
