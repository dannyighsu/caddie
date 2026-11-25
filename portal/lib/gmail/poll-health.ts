/**
 * Inbound poll health — timeouts, stall detection and alert throttling.
 *
 * Pure (apart from timers) and unit-tested, so the rules that decide "inbound
 * email has stopped flowing" can be exercised without a Gmail account, a Redis
 * connection or a running agent. The stateful shell is ./poller.
 *
 * Why this exists: the poller's dispatch loop awaited the agent run for each
 * message in turn, with no timeout anywhere and a `syncing` latch that was only
 * cleared in the poll's own `finally`. One await that never settled therefore
 * stopped inbound email permanently — the latch stayed up, every later tick
 * returned immediately, and because nothing had thrown there was no exception,
 * no failed run and no ledger row. Only `console.log` on the host recorded
 * anything, and nobody reads that. Inbound was dead for five days (2026-11-20
 * to 2026-11-25) before a team member asked why their mail went unanswered.
 *
 * So three rules, which the poller enforces with the helpers below:
 *
 *   1. **Every await has a deadline.** A step that overruns rejects, and a
 *      rejection is recoverable — the message is released and the loop moves on.
 *      Head-of-line blocking becomes one late message, not an outage.
 *   2. **The latch can always be released.** If a poll makes no progress for
 *      longer than {@link NO_PROGRESS_MS} it is abandoned: since every step is
 *      now bounded, no-progress past that bound means something escaped its
 *      deadline, and keeping the latch up would repeat the original bug.
 *   3. **A stall is audible.** Queue depth and age are checked on every tick,
 *      and mail sitting unhandled past {@link QUEUE_STALL_MS} alerts — once,
 *      then at most once per {@link RE_ALERT_MS} while the same thing is wrong.
 *      This is the check that would have caught the outage on day one.
 */

// ── Deadlines ─────────────────────────────────────────────────────────

/** Metadata/full-message fetch. A single API GET; seconds, not minutes. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * One message's dispatch — which awaits the whole agent run, so this is
 * generous by necessity. It is a backstop against a hang, not a performance
 * budget: a run that legitimately takes this long has other problems.
 */
export const DISPATCH_TIMEOUT_MS = 15 * 60_000;

/**
 * How long a poll may go without finishing a step before it is abandoned and
 * the latch released. Must exceed {@link DISPATCH_TIMEOUT_MS}, or a legitimately
 * slow dispatch would be abandoned while it was still running normally.
 */
export const NO_PROGRESS_MS = DISPATCH_TIMEOUT_MS + 5 * 60_000;

/** How old the oldest unhandled message may get before inbound counts as stalled. */
export const QUEUE_STALL_MS = 15 * 60_000;

/** Dispatch attempts for one message before it is quarantined rather than retried forever. */
export const MAX_DISPATCH_ATTEMPTS = 3;

/** While the same problem persists, re-alert at most this often. */
export const RE_ALERT_MS = 6 * 60 * 60 * 1000;

// ── Timeout wrapper ───────────────────────────────────────────────────

/** Rejection raised by {@link withTimeout}. Carries the label for logging. */
export class TimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;
  constructor(label: string, timeoutMs: number) {
    super(`${label} did not settle within ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Reject with {@link TimeoutError} if `promise` hasn't settled within `ms`.
 *
 * The underlying work is **not** cancelled — there is nothing to cancel a
 * googleapis call or an in-flight agent run with, and pretending otherwise
 * would be worse than saying so. What this buys is that the *caller* is freed:
 * the loop continues, the latch comes down, and the message is retried or
 * quarantined instead of silently wedging the queue forever. An abandoned
 * operation that later completes is harmless — the message is claimed in Redis,
 * so it cannot be dispatched twice.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    // Deliberately *not* unref'd: the whole point is to fire when the awaited
    // work has gone quiet, and an unref'd timer lets the loop drain first — so
    // the one case this exists for is the one case it would miss.
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// ── Poller status ─────────────────────────────────────────────────────

/** Everything the poller knows about its own liveness. Snapshot, not live state. */
export interface PollerStatus {
  /** False when Gmail isn't configured — inbound polling was never started. */
  enabled: boolean;
  /** Epoch ms the loop started. */
  startedAt?: number;
  /** Epoch ms the current/last poll began. */
  lastPollStartedAt?: number;
  /** Epoch ms the last poll finished cleanly. */
  lastPollCompletedAt?: number;
  /** Epoch ms a step last completed — the progress heartbeat. */
  lastProgressAt?: number;
  /** Epoch ms a message was last handed to the agent successfully. */
  lastDispatchAt?: number;
  /** Error text from the last failed poll, if the most recent poll failed. */
  lastPollError?: string;
  /** Consecutive whole-poll failures. Zero after any clean poll. */
  consecutivePollErrors: number;
  /** Polls abandoned for lack of progress since start. Any non-zero value is a bug. */
  abandonedPolls: number;
  /** Messages given up on after {@link MAX_DISPATCH_ATTEMPTS}. */
  quarantined: number;
  /** Unread messages seen in the queue on the last poll. */
  queueDepth?: number;
  /** Epoch ms of the oldest unhandled message in the queue. */
  oldestQueuedAt?: number;
}

/** A fresh status for a poller that is configured but hasn't polled yet. */
export function initialStatus(enabled: boolean, now: number): PollerStatus {
  return {
    enabled,
    startedAt: enabled ? now : undefined,
    consecutivePollErrors: 0,
    abandonedPolls: 0,
    quarantined: 0,
  };
}

/**
 * True when a poll that is still holding the latch has made no progress for
 * longer than {@link NO_PROGRESS_MS} and should be abandoned.
 */
export function isPollStuck(status: PollerStatus, now: number): boolean {
  if (status.lastPollStartedAt === undefined) return false;
  const since = status.lastProgressAt ?? status.lastPollStartedAt;
  return now - since > NO_PROGRESS_MS;
}

// ── Stall detection ───────────────────────────────────────────────────

export type StallKind = "queue-backlog" | "poll-errors" | "poll-abandoned" | "message-quarantined";

export interface Stall {
  kind: StallKind;
  /** One line for a human: what is wrong. */
  detail: string;
  /**
   * Collapses repeats of the same problem so the throttle can tell "still
   * broken the same way" from "broken differently now".
   */
  signature: string;
}

/**
 * The stall worth reporting right now, or null when inbound looks healthy.
 *
 * Only queue age and poll errors are derived here; `poll-abandoned` and
 * `message-quarantined` are events the poller reports directly, since they are
 * discrete things that happened rather than conditions to be observed.
 */
export function detectStall(status: PollerStatus, now: number): Stall | null {
  if (!status.enabled) return null;

  // Mail is sitting in the mailbox unhandled. This is the symptom that matters
  // regardless of which mechanism caused it, so it is checked first.
  if (status.oldestQueuedAt !== undefined && status.queueDepth) {
    const age = now - status.oldestQueuedAt;
    if (age > QUEUE_STALL_MS) {
      return {
        kind: "queue-backlog",
        detail:
          `${status.queueDepth} unread message(s) in the inbox queue; the oldest has been ` +
          `waiting ${Math.round(age / 60_000)} minutes. Inbound email is not being dispatched.`,
        signature: "queue-backlog",
      };
    }
  }

  if (status.consecutivePollErrors >= 3 && status.lastPollError) {
    return {
      kind: "poll-errors",
      detail:
        `${status.consecutivePollErrors} consecutive inbound polls failed. ` +
        `Last error: ${truncate(status.lastPollError, 400)}`,
      signature: `poll-errors:${errorSignature(status.lastPollError)}`,
    };
  }

  return null;
}

/** State the poller carries between ticks so alerts stay throttled. */
export interface AlertState {
  /** Epoch ms of the last alert actually delivered. */
  lastAlertAt?: number;
  /** Signature of the problem that alert was about. */
  lastSignature?: string;
}

/**
 * Whether to alert now. Alert on a problem that is new or has *changed*
 * (different failure, different news), then stay quiet for {@link RE_ALERT_MS}
 * while the same one persists. A permanently broken poller otherwise produces
 * an alert a minute, which is its own kind of silence.
 */
export function shouldAlert(state: AlertState, stall: Stall, now: number): boolean {
  if (state.lastSignature !== stall.signature) return true;
  if (state.lastAlertAt === undefined) return true;
  return now - state.lastAlertAt >= RE_ALERT_MS;
}

// ── Message text ──────────────────────────────────────────────────────

/** The alert body. Says what broke, what it means, and what to look at. */
export function formatStallAlert(agent: string, stall: Stall, status: PollerStatus): string {
  const lines = [
    `Inbound email is not flowing to ${agent}.`,
    "",
    stall.detail,
    "",
    `Last successful dispatch: ${stamp(status.lastDispatchAt)}`,
    `Last clean poll: ${stamp(status.lastPollCompletedAt)}`,
  ];
  if (status.abandonedPolls > 0) lines.push(`Polls abandoned for lack of progress: ${status.abandonedPolls}`);
  if (status.quarantined > 0) lines.push(`Messages quarantined after repeated failures: ${status.quarantined}`);
  lines.push(
    "",
    "Mail is still in the mailbox — nothing is lost — but it is not reaching the agent,",
    "so anyone who emailed is waiting on a reply that will not come. Slack is unaffected.",
  );
  return lines.join("\n");
}

/** The one-line recovery note, sent only if a stall was actually reported. */
export function formatRecoveryAlert(agent: string, status: PollerStatus): string {
  return (
    `Inbound email to ${agent} is flowing again — ` +
    `last dispatch ${stamp(status.lastDispatchAt)}, queue empty.`
  );
}

/** Health-check shape for the portal's pre-flight list. */
export function describePollerHealth(
  status: PollerStatus,
  now: number,
): { status: "ok" | "error" | "skipped"; message: string } {
  if (!status.enabled) {
    return { status: "skipped", message: "Gmail not configured — inbound polling disabled" };
  }
  const stall = detectStall(status, now);
  if (stall) return { status: "error", message: stall.detail };
  if (status.lastPollCompletedAt === undefined) {
    return { status: "ok", message: "started, first poll in progress" };
  }
  const queue = status.queueDepth ? `, ${status.queueDepth} queued` : "";
  return {
    status: "ok",
    message: `last clean poll ${stamp(status.lastPollCompletedAt)}${queue}`,
  };
}

// ── helpers ───────────────────────────────────────────────────────────

/** Digits stripped so timestamps, ids and counts in an error don't defeat the throttle. */
export function errorSignature(error: string): string {
  return error.replace(/\d+/g, "#").slice(0, 200);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function stamp(ms?: number): string {
  return ms === undefined ? "never" : new Date(ms).toISOString();
}
