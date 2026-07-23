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
import { classifyRunFailure } from "./failure-classifier";
import { sendEmail, isEmailConfigured } from "./email";

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

  // Only API-layer failures alert the owner; ordinary agent-task errors surface
  // through each channel's normal error path.
  const classified = await classifyRunFailure(agentId, result);
  if (!classified || classified.failureClass !== "api") return;
  const { code, detail } = classified;

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
