/**
 * Agent Runtime Factory
 *
 * Creates the configured Agent Runtime based on environment/config.
 * Defaults to ClaudeCodeRuntime.
 */

import type { AgentRuntime } from "../runtime";
import { ClaudeCodeRuntime } from "./claude-code";

/**
 * Create the default runtime based on environment configuration.
 * Extensible — add new runtime types here as they become available.
 */
export function createDefaultRuntime(): AgentRuntime {
  const runtimeType = process.env.AGENT_RUNTIME ?? "claude-code";

  switch (runtimeType) {
    case "claude-code":
      return new ClaudeCodeRuntime({
        claudeBinary: process.env.CLAUDE_BINARY,
        model: process.env.CLAUDE_MODEL,
      });
    default:
      console.warn(
        `[Runtime] Unknown runtime type "${runtimeType}", falling back to claude-code`
      );
      return new ClaudeCodeRuntime();
  }
}

/**
 * Create a runtime with Chrome enabled and extended timeout (for X Manager).
 */
export function createBrowserRuntime(): AgentRuntime {
  const { XMANAGER_TIMEOUT_MS } = require("./claude-code");
  return new ClaudeCodeRuntime({
    claudeBinary: process.env.CLAUDE_BINARY,
    model: process.env.CLAUDE_MODEL,
    timeoutMs: XMANAGER_TIMEOUT_MS,
  });
}
