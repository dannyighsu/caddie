/**
 * Run Failure Alerts
 *
 * When a run fails at the API layer — expired OAuth, rate limit, overload — the
 * team owner is otherwise blind to it: there is no agent output to
 * reply with, so the originating channel stays silent, and the cause is
 * infrastructure only the owner can fix (usually re-authenticating Claude Code).
 * This module detects that class of failure and emails danny directly.
 *
 * This is deliberately narrow: ordinary agent-task errors are NOT routed here —
 * they surface through each channel's normal error path. Only API-layer
 * failures (the `isApiErrorMessage` class) alert the owner.
 */

import type { AgentResult } from "@ignis/harness";
import { classifyRunFailure } from "./failure-classifier";
import { sendEmail, isEmailConfigured } from "./email";
import { teamOwner } from "@ignis/harness";
import { getTeamRoster } from "./team";
import { agentName } from "./agent-name";

function transcriptUrl(sessionId: string): string {
  const base = process.env.PORTAL_URL ?? "http://localhost:3000";
  return `${base}/transcripts/${sessionId}`;
}

/**
 * If `result` represents an API-layer failure, email danny. Best-effort: never
 * throws — a failed alert must not mask the underlying run failure.
 */
export async function alertOwnerOnApiFailure(
  result: Pick<AgentResult, "success" | "error" | "sessionId">
): Promise<void> {
  if (result.success) return;

  // Only API-layer failures alert the owner; ordinary agent-task errors surface
  // through each channel's normal error path.
  const classified = await classifyRunFailure(result);
  if (!classified || classified.failureClass !== "api") return;
  const { code, detail } = classified;
  const name = agentName();

  const to = teamOwner(await getTeamRoster().catch(() => []))?.emails[0];
  if (!to || !isEmailConfigured()) {
    console.error(
      `[RunAlerts] API-layer failure (${code}) but ` +
        `${to ? "email is not configured" : "the team has no owner with an email"}: ${detail}`
    );
    return;
  }

  const link = result.sessionId
    ? `\nTranscript: ${transcriptUrl(result.sessionId)}\n`
    : "";
  const subject = `⚠️ ${name} run failed at the API layer (${code})`;
  const body =
    `A ${name} run failed before it could complete.\n\n` +
    `Error: ${detail}\n` +
    link +
    `\nThis is an infrastructure failure at the Claude API layer — not an agent ` +
    `error. It usually means the Claude Code OAuth session has expired and needs ` +
    `to be re-authenticated.`;

  try {
    await sendEmail(to, subject, body);
    console.log(
      `[RunAlerts] Emailed ${to} about API-layer failure (${code}).`
    );
  } catch (err) {
    console.error(`[RunAlerts] Failed to deliver API-failure alert email:`, err);
  }
}
