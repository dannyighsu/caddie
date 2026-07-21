/**
 * Run Failure Alerts
 *
 * When a run fails at the API layer — expired OAuth, rate limit, overload — the
 * household owner (danny) is otherwise blind to it: there is no agent output to
 * reply with, so the originating channel stays silent, and the cause is
 * infrastructure only the owner can fix (usually re-authenticating Claude Code).
 * This module detects that class of failure and emails danny directly.
 *
 * This is deliberately narrow: ordinary agent-task errors are NOT routed here —
 * they surface through each channel's normal error path. Only API-layer
 * failures (the `isApiErrorMessage` class) alert the owner.
 */

import type { AgentResult } from "@agints/harness";
import { getApiError } from "./transcripts";
import { sendEmail, isEmailConfigured } from "./email";

// Fallback signatures for when the run died before a session transcript existed
// (no sessionId to inspect). Matched case-insensitively against result.error.
const API_ERROR_SIGNATURES = [
  "authentication_failed",
  "failed to authenticate",
  "oauth",
  "overloaded",
  "rate limit",
  "rate_limit",
  "usage limit",
  "credit balance",
];

function matchesApiSignature(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return API_ERROR_SIGNATURES.some((sig) => e.includes(sig));
}

function transcriptUrl(agentId: string, sessionId: string): string {
  const base = process.env.NORTHSTAR_BASE_URL ?? "http://localhost:3000";
  return `${base}/transcripts/${sessionId}?agentId=${agentId}`;
}

/**
 * If `result` represents an API-layer failure, email danny. Best-effort: never
 * throws — a failed alert must not mask the underlying run failure.
 */
export async function alertOwnerOnApiFailure(
  agentId: string,
  result: Pick<AgentResult, "success" | "error" | "sessionId">
): Promise<void> {
  if (result.success) return;

  // Canonical signal: the transcript's synthetic API-error entry. Fall back to
  // matching the error string when no session transcript is available (e.g. the
  // process died before the session envelope was written).
  let code = "api_error";
  let detail: string | null = null;

  if (result.sessionId) {
    const apiErr = await getApiError(agentId, result.sessionId).catch(() => null);
    if (apiErr) {
      code = apiErr.type;
      detail = apiErr.message;
    }
  }
  if (!detail && matchesApiSignature(result.error)) {
    detail = result.error ?? "Unknown API-layer error";
  }
  if (!detail) return; // Not an API-layer failure — leave to normal error paths.

  const to = process.env.DANNY_EMAIL;
  if (!to || !isEmailConfigured()) {
    console.error(
      `[RunAlerts] API-layer failure for "${agentId}" (${code}) but email is not configured: ${detail}`
    );
    return;
  }

  const link = result.sessionId
    ? `\nTranscript: ${transcriptUrl(agentId, result.sessionId)}\n`
    : "";
  const subject = `⚠️ ${agentId} run failed at the API layer (${code})`;
  const body =
    `A run for agent "${agentId}" failed before it could complete.\n\n` +
    `Error: ${detail}\n` +
    link +
    `\nThis is an infrastructure failure at the Claude API layer — not an agent ` +
    `error. It usually means the Claude Code OAuth session has expired and needs ` +
    `to be re-authenticated.`;

  try {
    await sendEmail(to, subject, body);
    console.log(
      `[RunAlerts] Emailed ${to} about API-layer failure (${code}) for "${agentId}".`
    );
  } catch (err) {
    console.error(`[RunAlerts] Failed to deliver API-failure alert email:`, err);
  }
}
