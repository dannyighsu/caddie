/**
 * @agints/harness — Modular Agent Workflow System
 *
 * Public API:
 *   createLauncher() — create a workflow launcher bound to a runtime and directories
 *   createRuntime()  — create an agent runtime from config
 *
 * Types:
 *   AgentRuntime, AgentRuntimeInput, AgentRuntimeOutput, MCPServerConfig
 *   WorkflowConfig, WorkflowInput, WorkflowResult
 *   TriggerContext
 */

// Runtime
export type {
  AgentRuntime,
  AgentRuntimeInput,
  AgentRuntimeOutput,
  MCPServerConfig,
} from "./runtime/types.js";
export { ClaudeCodeRuntime, type ClaudeCodeRuntimeOptions } from "./runtime/claude-code.js";
export { createRuntime, type RuntimeConfig } from "./runtime/factory.js";

// Workflow
export type { WorkflowConfig, WorkflowInput, WorkflowResult } from "./workflow/types.js";
export { createLauncher, type LauncherConfig } from "./workflow/launcher.js";

// Capability
export { resolveCapabilities, type ResolveResult } from "./capability/mcp-resolver.js";

// Trigger
export type { TriggerContext } from "./trigger/types.js";
