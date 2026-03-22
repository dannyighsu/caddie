/**
 * Trigger Context
 *
 * Describes how and why a workflow was invoked.
 * Passed through to the launcher for logging/tracing — the runtime doesn't use it.
 */

export interface TriggerContext {
  /** How the workflow was triggered. */
  source: "cron" | "webhook" | "cli" | "api";
  /** Arbitrary metadata about the trigger (e.g., slack channel, cron schedule name). */
  metadata?: Record<string, unknown>;
}
