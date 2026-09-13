/**
 * Reply check for inbound ("tool" delivery) runs.
 *
 * On an inbound run the agent's final text is never delivered — only a `reply`
 * tool call reaches the person who wrote in. A run that ends without one (e.g.
 * it ended its turn "waiting" on background work that never came back) leaves
 * the sender with silence while the ledger records a success. So when a run
 * ends with no reply delivered, the messaging layer resumes the session ONCE
 * with REPLY_NUDGE_PROMPT. Once only: deliberate silence (promotional mail, a
 * group thread the agent wasn't addressed in) is still allowed, and a second
 * silent ending is accepted as final — no loops.
 *
 * Pure logic, no imports, so it's unit-testable under `node --test`.
 */

export const REPLY_NUDGE_PROMPT =
  "[Harness reminder] This run ended without a `reply` being delivered, so the person " +
  "who wrote in hasn't heard anything back — your final text is never sent to them. " +
  "You run as a one-shot CLI process: once you end your turn here, the run is over for " +
  "good and any unfinished work is dropped.\n\n" +
  "- If you have results (including anything your background agents already reported), " +
  "send them now with `reply`.\n" +
  "- If the work isn't finished, `reply` with what you have and what's still open.\n" +
  "- If you deliberately decided no reply is warranted (e.g. promotional mail, or a group " +
  "thread you weren't addressed in), or you did already reply, just end without calling it.\n\n" +
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
