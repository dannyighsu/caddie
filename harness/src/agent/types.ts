/**
 * Agent Types
 *
 * One install runs one agent: a system prompt (SYSTEM.md, committed) and a
 * persona (PERSONA.md, per install), capabilities (MCP servers), resolvers
 * (pre-run data fetching), and optionally skills (Claude Code native SKILL.md).
 * Variation between runs is a profile, never a second agent.
 */

import type { TriggerContext } from "../trigger/types.js";

/**
 * Trust tier for an agent run. The permission policy (harness/permissions.json)
 * grants each tier a set of capabilities plus the built-in tools; see
 * ../policy/permissions.ts and docs/PERMISSIONS.md. `guest` is default-deny
 * (nothing granted).
 *
 * Resolved by the caller (e.g. the portal's messaging layer) from the inbound
 * sender's identity — never from message content.
 */
export type TrustTier = "team" | "guest";

/**
 * The origin identity of a run. Trust and "who" travel together as one object
 * so a caller can't supply one without the other. The caller (e.g. the portal)
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
  /** Capability names — references to JSON files in the capabilities directory. */
  capabilities: string[];
  /** Resolver names — pre-run data fetchers that inject context variables. */
  resolvers?: string[];
  /** JSON Schema for structured output. Omit for free-form conversational mode. */
  outputSchema?: Record<string, unknown>;
  /** Maximum agent loop iterations. Defaults to 150 (DEFAULT_MAX_TURNS). */
  maxTurns?: number;
  /** Whether this agent needs Chrome browser automation. */
  enableChrome?: boolean;
  /** Config files to read and inject as context variables. Maps var name to workspace-relative path. */
  configFiles?: Record<string, string>;
  /**
   * Named run variants of this same agent. A profile keeps the agent's identity
   * and persona and varies only what it can reach and how long it may run.
   *
   * Capabilities are adjusted relative to the base set rather than replacing it,
   * so a profile can never silently drop something every run needs (`reply`
   * being the load-bearing example — an inbound run without it executes and
   * then says nothing).
   */
  profiles?: Record<string, AgentProfile>;
}

/** One named run variant of an agent. All fields are optional adjustments. */
export interface AgentProfile {
  /** Capability names to add to the agent's base set. */
  addCapabilities?: string[];
  /** Capability names to remove from the agent's base set. Applied before adds. */
  removeCapabilities?: string[];
  /**
   * Skill directory names this profile may use. Omit to mount every skill the
   * agent has (the default). When set, only these are visible to the run.
   */
  skills?: string[];
  /** Replaces the agent's resolver list outright. */
  resolvers?: string[];
  /** Replaces the agent's turn ceiling. */
  maxTurns?: number;
  /** Replaces the agent's Chrome setting. */
  enableChrome?: boolean;
  /** Profile-specific config files, merged over the agent's. */
  configFiles?: Record<string, string>;
}

/**
 * Input to launch an agent execution.
 */
export interface AgentInput {
  /** Which named profile to run as. Omit for the agent's base configuration. */
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
  /**
   * The run's "now", for values the launcher derives from the clock (the
   * run-record path). Defaults to the real time. Evals replaying a past
   * situation set it so nothing in the run context contradicts the
   * `currentTime` header.
   */
  now?: Date;
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
