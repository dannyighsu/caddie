/**
 * Context Enrichers & Orchestrator Registry
 *
 * Context enrichers provide lightweight pre-launch data for agent runs.
 * The orchestrator registry is available for agents that need server-side
 * lifecycle management (e.g., conversation persistence, self-rescheduling),
 * but most agents should handle their own lifecycle via skills and tools.
 *
 * Agents without an orchestrator launch directly via the gateway/scheduler.
 */


// --- Orchestrator Registry ---

type Orchestrator = (params: OrchestratorParams) => Promise<Record<string, unknown>>;

export interface OrchestratorParams {
  prompt?: string;
  conversationId?: string;
  slackChannel?: string;
  context?: Record<string, string>;
  /** Skip Slack posting (caller handles it, e.g., Slack handler replies in thread). */
  skipSlack?: boolean;
}

const orchestrators: Record<string, Orchestrator> = {};

/**
 * Get the orchestrator for an agent+profile combination.
 * Checks for "agentId:profile" first, then falls back to "agentId".
 */
export function getOrchestrator(agentId: string, profile?: string): Orchestrator | null {
  if (profile) {
    const specific = orchestrators[`${agentId}:${profile}`];
    if (specific) return specific;
  }
  return orchestrators[agentId] ?? null;
}

// --- Context Enrichers ---
//
// Lightweight context providers used by the shared messaging path.
// These only gather additional context for the agent launch —
// conversation management stays in the caller.

type ContextEnricher = () => Promise<Record<string, string>>;

const contextEnrichers: Record<string, ContextEnricher> = {};

/**
 * Get a context enricher for an agent+profile combination.
 * Returns additional context to merge into the agent launch,
 * without taking over the full execution lifecycle.
 */
export function getContextEnricher(agentId: string, profile?: string): ContextEnricher | null {
  if (profile) {
    const specific = contextEnrichers[`${agentId}:${profile}`];
    if (specific) return specific;
  }
  return contextEnrichers[agentId] ?? null;
}

// --- Helpers ---

export function currentTimePST(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}
