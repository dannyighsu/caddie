/**
 * Deferral window for a recurring occurrence that couldn't acquire the
 * active-run lock.
 *
 * Pure time arithmetic, kept out of redis.ts so it can be tested without a
 * Redis connection. See `deferRecurringJob` in ./redis.ts for the caller.
 */

/** How far ahead a blocked occurrence is pushed before it tries again. */
export const DEFAULT_DEFER_MS = 2 * 60 * 1000; // 2 minutes

export interface DeferralInput {
  /** Now, epoch ms. */
  now: number;
  /**
   * The job's next natural cron occurrence — i.e. `job.nextRun` as
   * `markJobFired` has already advanced it. This is the deadline for retrying
   * the blocked occurrence: past it, the natural fire takes over.
   */
  naturalNext: number;
  /**
   * Deadline carried on the job from an earlier deferral of this same
   * occurrence. Once we start deferring, `job.nextRun` no longer holds the
   * natural occurrence, so the deadline has to be remembered separately or
   * repeated deferrals would walk past it forever.
   */
  deadline?: number;
  /** Override the retry delay (default `DEFAULT_DEFER_MS`). */
  delayMs?: number;
}

export interface Deferral {
  /** New `nextRun` for the job. */
  nextRun: number;
  /** Deadline to persist, so a later deferral of the same occurrence is capped. */
  deadline: number;
}

/**
 * Where to put a blocked recurring occurrence, or null if it shouldn't be
 * deferred at all — the deadline (its next natural occurrence) is already here,
 * so there's nothing to preserve and the natural fire handles it.
 */
export function computeDeferral(input: DeferralInput): Deferral | null {
  const { now, naturalNext } = input;
  const deadline = input.deadline ?? naturalNext;
  if (!Number.isFinite(deadline) || deadline <= now) return null;
  const delayMs = input.delayMs ?? DEFAULT_DEFER_MS;
  return { nextRun: Math.min(now + delayMs, deadline), deadline };
}
