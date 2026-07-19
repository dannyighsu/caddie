/**
 * Thread Context ("source task frontmatter")
 *
 * A small block of factual metadata about the task run that created an outbound
 * email thread. It rides the run env → email-mcp → control API → conversation
 * record, and is replayed to whoever handles a reply so the agent knows where
 * the thread came from (and can act on it — e.g. stop a recurring reminder).
 *
 * Deliberately just facts — no behavioral directives. The agent decides what to
 * do from its persona + these facts + its normal tools (e.g. delete_schedule).
 */
export interface ThreadContext {
  /** The originating job/task id (actionable handle, e.g. for delete_schedule). */
  taskId: string;
  /** Human-readable description of the task. */
  description?: string;
  /** Cron expression, if the task is recurring. */
  schedule?: string;
  /** ISO timestamp this run was due to fire. Omitted for manual "run now". */
  scheduledTime?: string;
  /** ISO timestamp the run actually executed. */
  runTime: string;
}

/** Render a thread context to a plain-facts preamble for the reply prompt. */
export function renderThreadContext(ctx: ThreadContext): string {
  const lines = [`- Task ID: ${ctx.taskId}`];
  if (ctx.description) lines.push(`- Description: ${ctx.description}`);
  if (ctx.schedule) lines.push(`- Schedule (cron): ${ctx.schedule}`);
  if (ctx.scheduledTime) lines.push(`- Scheduled for: ${ctx.scheduledTime}`);
  lines.push(`- Ran: ${ctx.runTime}`);
  return (
    "Source task (this email thread was created by one of your own tasks):\n" +
    lines.join("\n")
  );
}

/** Parse a ThreadContext from a JSON string (e.g. an env var); null if invalid. */
export function parseThreadContext(raw: string | undefined | null): ThreadContext | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as ThreadContext;
    return obj && typeof obj.taskId === "string" ? obj : null;
  } catch {
    return null;
  }
}
