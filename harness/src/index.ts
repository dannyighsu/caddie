/**
 * @agints/harness — Modular Agent System
 *
 * Public API:
 *   createLauncher() — create an agent launcher bound to a runtime and directories
 *   createRuntime()  — create an agent runtime from config
 *
 * Types:
 *   AgentConfig, AgentInput, AgentResult
 *   AgentRuntime, AgentRuntimeInput, AgentRuntimeOutput, MCPServerConfig
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

// Agent
export type { AgentConfig, AgentInput, AgentResult, TrustTier, RunIdentity } from "./agent/types.js";
export { createLauncher, type LauncherConfig } from "./agent/launcher.js";

// Capability
export { resolveCapabilities, type ResolveResult } from "./capability/mcp-resolver.js";

// Permission policy (single source of truth: harness/permissions.json)
export {
  loadPermissions,
  isAllowed,
  filterCapabilitiesByPolicy,
  BASE_TOOLS_KEY,
  type PermissionPolicy,
  type CapabilityFilterResult,
} from "./policy/permissions.js";

// Resolver
export type {
  ResolverDefinition,
  ResolverModule,
  ResolverConfig,
} from "./resolver/types.js";
export { runResolvers } from "./resolver/runner.js";

// Trigger
export type { TriggerContext } from "./trigger/types.js";
