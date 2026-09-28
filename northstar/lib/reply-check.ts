/**
 * Reply check for inbound ("tool" delivery) runs.
 *
 * On an inbound run the agent's final text is never delivered — only a `reply`
 * tool call reaches the person who wrote in. The failure this guards against is
 * narrow: the agent *wrote* its answer, but as final text instead of calling
 * `reply` (2026-09-17: a full answer to "have you been running the golf job?"
 * that nobody would have seen). So when a run ends with no reply delivered, the
 * messaging layer resumes the session ONCE with REPLY_NUDGE_PROMPT.
 *
 * The prompt is deliberately only about that case. Silence is usually a
 * decision — an acknowledgement, auto-mail, something taken to the team — and
 * an earlier wording ("reply with what you have and what's still open") pushed
 * runs that had correctly stayed silent into sending vendors holding replies.
 * A second silent ending is accepted as final — no loops.
 *
 * Pure logic, no imports, so it's unit-testable under `node --test`.
 */

export const REPLY_NUDGE_PROMPT =
  "[Harness reminder] This run ended without calling `reply`. Your final text is never " +
  "delivered — only `reply` reaches the person who wrote in.\n\n" +
  "- If your final text was an answer you meant to send them, send it now with `reply`.\n" +
  "- If you decided not to reply (nothing to act on, it wasn't for you, or you took it to " +
  "the team instead), end now without calling it. Don't send a holding message or an " +
  "acknowledgement because of this reminder.\n\n" +
  "This reminder is sent only once.";

/**
 * Number of assistant turns in a conversation. Every delivered `reply` appends
 * one (the control API records it at send time), so a count that didn't grow
 * over a run means nothing was delivered.
 */
export function countAssistantTurns(messages: ReadonlyArray<{ role: string }>): number {
  return messages.filter((m) => m.role === "assistant").length;
}

/**
 * Whether a finished run should get the one-time reply reminder: an inbound
 * ("tool" delivery) run that succeeded, can be resumed, and delivered nothing.
 * A failed run is left alone — its error path already notifies the sender.
 */
export function needsReplyNudge(run: {
  deliveryMode: "auto" | "tool";
  success: boolean;
  sessionId: string;
  repliesBefore: number;
  repliesAfter: number;
}): boolean {
  return (
    run.deliveryMode === "tool" &&
    run.success &&
    !!run.sessionId &&
    run.repliesAfter <= run.repliesBefore
  );
}

/**
 * Combine the usage blobs of a run and its nudge so the ledger reports the
 * total cost. Numeric fields are summed; anything else keeps the first value.
 */
export function mergeUsage(
  a?: Record<string, unknown>,
  b?: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!a) return b;
  if (!b) return a;
  const merged: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const prev = merged[key];
    merged[key] =
      typeof prev === "number" && typeof value === "number" ? prev + value : (prev ?? value);
  }
  return merged;
}
