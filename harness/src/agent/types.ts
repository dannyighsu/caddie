/**
 * Agent Types
 *
 * An agent = an identity with a persona (system prompt), capabilities (MCP servers),
 * resolvers (pre-run data fetching), and optionally skills (Claude Code native SKILL.md).
 */

import type { TriggerContext } from "../trigger/types.js";

/**
 * Static agent configuration, loaded from agent.json.
 */
export interface AgentConfig {
  /** Unique agent identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Path to persona markdown file (relative to agent dir), or inline string. */
  persona: string;
  /** Capability names — references to JSON files in the capabilities directory. */
  capabilities: string[];
  /** Resolver names — pre-run data fetchers that inject context variables. */
  resolvers?: string[];
  /** JSON Schema for structured output. Omit for free-form conversational mode. */
  outputSchema?: Record<string, unknown>;
  /** Maximum agent loop iterations. Defaults to 20. */
  maxTurns?: number;
  /** Whether this agent needs Chrome browser automation. */
  enableChrome?: boolean;
  /** Agent mode: "conversational" (default) for chat UI, "triggered" for run-button UI. */
  mode?: "conversational" | "triggered";
  /** API route the control plane hits for triggered agents (e.g., "/api/xmanager/run"). */
  triggerRoute?: string;
}

/**
 * Input to launch an agent execution.
 */
export interface AgentInput {
  /** Which agent to run. */
  agentId: string;
  /** The user's message or task prompt. */
  prompt: string;
  /** Resume a prior session for conversation continuation. */
  sessionId?: string;
  /** Template variables injected into the persona ({{key}} -> value). */
  context?: Record<string, string>;
  /** How/why this agent was triggered. */
  trigger?: TriggerContext;
  /** Override the working directory (otherwise derived from workspaceRoot + agentId). */
  workingDirectory?: string;
}

/**
 * Result of an agent execution.
 */
export interface AgentResult {
  success: boolean;
  /** Structured output if the agent defines an outputSchema. */
  output: Record<string, unknown> | null;
  /** The agent's full text response. */
  rawText: string;
  /** Session ID for resumption. */
  sessionId: string;
  error?: string;
}
