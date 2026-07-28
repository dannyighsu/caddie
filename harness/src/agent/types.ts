/**
 * Agent Types
 *
 * An agent = an identity with a persona (system prompt), capabilities (MCP servers),
 * resolvers (pre-run data fetching), and optionally skills (Claude Code native SKILL.md).
 */

import type { TriggerContext } from "../trigger/types.js";

/**
 * Trust tier for an agent run. The permission policy (harness/permissions.json)
 * grants each tier a set of capabilities plus the built-in tools; see
 * ../policy/permissions.ts and docs/PERMISSIONS.md. `guest` is default-deny
 * (nothing granted).
 *
 * Resolved by the caller (e.g. northstar's messaging layer) from the inbound
 * sender's identity — never from message content.
 */
export type TrustTier = "household" | "guest";

/**
 * The origin identity of a run. Trust and "who" travel together as one object
 * so a caller can't supply one without the other. The caller (e.g. northstar)
 * derives this from a resolved sender identity.
 */
export interface RunIdentity {
  /** Permission tier — selects capabilities + built-in tools via permissions.json. */
  trustTier: TrustTier;
  /** Human-readable "who" for the persona. Rendered as {{senderIdentity}}. */
  senderIdentity: string;
  /** Where the run originated (e.g. "email", "portal", "schedule"). {{originChannel}}. */
  originChannel: string;
}

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
  /** Config files to read and inject as context variables. Maps var name to workspace-relative path. */
  configFiles?: Record<string, string>;
  /** Named capability profiles. Overrides base capabilities/resolvers/maxTurns/enableChrome when selected. */
  profiles?: Record<string, {
    capabilities?: string[];
    resolvers?: string[];
    maxTurns?: number;
    enableChrome?: boolean;
    /** Profile-specific config files, merged with base configFiles. */
    configFiles?: Record<string, string>;
  }>;
}

/**
 * Input to launch an agent execution.
 */
export interface AgentInput {
  /** Which agent to run. */
  agentId: string;
  /** Which profile to use (overrides base capabilities). */
  profile?: string;
  /**
   * Origin identity for this run — trust tier, sender, and origin channel,
   * bundled so they always travel together. Required: every entry point must
   * state who is driving the run and at what trust.
   */
  identity: RunIdentity;
  /** The user's message or task prompt. */
  prompt: string;
  /** Resume a prior session for conversation continuation. */
  sessionId?: string;
  /** Template variables injected into the persona ({{key}} -> value). */
  context?: Record<string, string>;
  /** How/why this agent was triggered. */
  trigger?: TriggerContext;
  /** Additional environment variables passed to the runtime subprocess. */
  additionalEnv?: Record<string, string>;
  /**
   * Identifies this run's job so the launcher injects the job's state file
   * (`state/<stateKey>.md`) into the run context. That file is the per-job
   * store for agent-maintained state (dedup markers, pauses) and expiring
   * human directives. Omit for runs with no associated job (e.g. ad-hoc chat).
   */
  stateKey?: string;
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
  /** Token usage and cost metadata, if available. */
  usage?: Record<string, unknown>;
}
