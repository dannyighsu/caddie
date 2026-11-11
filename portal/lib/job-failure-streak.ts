/**
 * Job Failure Streaks — the pure decision and formatting layer behind
 * `job-failure-alerts`.
 *
 * Kept free of imports so the throttle rules are unit-testable without a Redis
 * or a Slack: `recordFailure` folds one failure into the streak carried from the
 * last tick and says whether to alert, and the `format*` functions produce the
 * text. `job-failure-alerts` owns the state and the delivery.
 */

/** How long an unchanged, still-failing job stays quiet between alerts. */
export const RE_ALERT_MS = 6 * 60 * 60 * 1000;

/** How much of the raw error text goes into a chat message. */
export const MAX_ERROR_CHARS = 500;

/** Consecutive failures of one job, as carried between ticks. */
export interface FailureStreak {
  /** Normalized error text — the streak continues only while this is stable. */
  signature: string;
  /** Verbatim error from the most recent failure (what alerts quote). */
  error: string;
  /** First failure in this streak (ms epoch). */
  firstAt: number;
  /** Most recent failure (ms epoch). */
  lastAt: number;
  /** How many consecutive failures, including the most recent. */
  count: number;
  /** When an alert about this streak was last *delivered*, or null if never. */
  lastNotifiedAt: number | null;
  /** How many alerts about this streak were delivered. */
  notifiedCount: number;
}

export type AlertReason = "first" | "changed" | "reminder" | "suppressed";

export interface AlertDecision {
  notify: boolean;
  reason: AlertReason;
  streak: FailureStreak;
}

/**
 * Collapse an error message to something stable across repeats of the same
 * fault. Timestamps, durations and pids differ on every tick of an identically
 * broken job, and without this each repeat would read as a new failure and
 * defeat the throttle.
 */
export function failureSignature(error: string): string {
  return error
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "<t>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 300);
}

/**
 * Fold a new failure into the carried streak and decide whether to alert.
 *
 * Pure: the caller persists `streak` and, if it delivered, calls `markNotified`.
 * `notify` is true when this is the first failure, when the error text changed
 * (a new fault, worth saying immediately), when no alert about this streak has
 * ever been delivered (a previous attempt failed — keep trying), or when the
 * quiet period has elapsed.
 */
export function recordFailure(
  prev: FailureStreak | null,
  error: string,
  now: number = Date.now(),
  reAlertMs: number = RE_ALERT_MS
): AlertDecision {
  const signature = failureSignature(error);

  if (!prev || prev.signature !== signature) {
    return {
      notify: true,
      reason: prev ? "changed" : "first",
      streak: {
        signature,
        error,
        firstAt: now,
        lastAt: now,
        count: 1,
        lastNotifiedAt: null,
        notifiedCount: 0,
      },
    };
  }

  const streak: FailureStreak = {
    ...prev,
    error,
    lastAt: now,
    count: prev.count + 1,
  };

  // Never delivered: a previous alert attempt failed, so this isn't a repeat
  // anyone has heard — try again rather than waiting out the quiet period.
  if (prev.lastNotifiedAt === null) {
    return { notify: true, reason: "first", streak };
  }
  if (now - prev.lastNotifiedAt >= reAlertMs) {
    return { notify: true, reason: "reminder", streak };
  }
  return { notify: false, reason: "suppressed", streak };
}

/** Stamp a streak as alerted. Called only after a delivery actually succeeded. */
export function markNotified(
  streak: FailureStreak,
  now: number = Date.now()
): FailureStreak {
  return {
    ...streak,
    lastNotifiedAt: now,
    notifiedCount: streak.notifiedCount + 1,
  };
}

function ptTime(ms: number): string {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function durationWords(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/**
 * The chat/email text for a failure alert. A repeat says how long the job has
 * been broken and how often, so a reminder reads as an escalation rather than a
 * duplicate of the first alert.
 */
export function formatFailureAlert(
  label: string,
  decision: AlertDecision,
  reAlertMs: number = RE_ALERT_MS
): string {
  const { streak, reason } = decision;
  const head =
    reason === "changed"
      ? `:warning: *Scheduled job failing with a new error:* ${label}`
      : `:warning: *Scheduled job failed:* ${label}`;
  const body = `\`\`\`${streak.error.substring(0, MAX_ERROR_CHARS)}\`\`\``;

  if (streak.count === 1) return `${head}\n${body}`;

  return [
    head,
    body,
    `_${streak.count} consecutive failures since ${ptTime(streak.firstAt)} PT ` +
      `(${durationWords(streak.lastAt - streak.firstAt)}). ` +
      `Further repeats of this error stay quiet for ~${durationWords(reAlertMs)}._`,
  ].join("\n");
}

/** The one-line recovery notice for a job that ran clean after alerted failures. */
export function formatRecoveryAlert(label: string, streak: FailureStreak): string {
  return (
    `:white_check_mark: *Scheduled job recovered:* ${label} — ran clean after ` +
    `${streak.count} consecutive failure${streak.count === 1 ? "" : "s"} ` +
    `(${durationWords(streak.lastAt - streak.firstAt)}, first at ${ptTime(streak.firstAt)} PT).`
  );
}

/** The owner-email fallback body: the chat text plus why it arrived by email. */
export function formatFallbackEmail(
  label: string,
  message: string,
  channel: string,
  channelError: string
): string {
  return [
    message.replace(/[:*]/g, ""),
    "",
    `This arrived by email because the job's own notification channel ` +
      `(${channel}) could not take it:`,
    `  ${channelError}`,
    "",
    `Job: ${label}`,
    `Fix the channel (or set the job's notificationRecipient) and alerts go ` +
      `back to ${channel}.`,
  ].join("\n");
}

