/**
 * Agent Runtime Factory
 *
 * Creates the configured Agent Runtime based on environment/config.
 * Extensible — add new runtime types here as they become available.
 */

import type { AgentRuntime } from "./types.js";
import { ClaudeCodeRuntime, type ClaudeCodeRuntimeOptions } from "./claude-code.js";

export interface RuntimeConfig {
  /** Runtime type identifier. Defaults to "claude-code". */
  type?: string;
  /** Runtime-specific options. */
  options?: Record<string, unknown>;
}

/**
 * Create a runtime from configuration.
 * Falls back to claude-code if type is unrecognized.
 */
export function createRuntime(config: RuntimeConfig = {}): AgentRuntime {
  const runtimeType = config.type ?? process.env.AGENT_RUNTIME ?? "claude-code";

  switch (runtimeType) {
    case "claude-code":
      return new ClaudeCodeRuntime({
        claudeBinary: (config.options?.claudeBinary as string) ?? process.env.CLAUDE_BINARY,
        model: (config.options?.model as string) ?? process.env.CLAUDE_MODEL,
        effort: (config.options?.effort as string) ?? process.env.CLAUDE_EFFORT,
        timeoutMs: config.options?.timeoutMs as number | undefined,
        bgWaitCeilingMs:
          (config.options?.bgWaitCeilingMs as number | undefined) ??
          (process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS
            ? Number(process.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS)
            : undefined),
      });
    default:
      console.warn(
        `[Runtime] Unknown runtime type "${runtimeType}", falling back to claude-code`
      );
      return new ClaudeCodeRuntime();
  }
}
