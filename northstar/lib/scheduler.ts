/**
 * Job Scheduler
 *
 * In-process polling loop that checks Redis for due jobs and fires them.
 * Starts once via instrumentation.ts when the server boots.
 *
 * Each job fires through the orchestrator registry when available,
 * or directly via the launcher with tracing + active-run locking.
 *
 * Recurring jobs re-schedule automatically after firing.
 * One-shot jobs are removed after firing.
 */

import {
  getDueJobs,
  markJobFired,
  overrideNextRun,
  acquireActiveRun,
  clearActiveRun,
  isRunActive,
  type ScheduledJob,
} from "./redis";
import { currentTimePST } from "./helpers";
import { getLauncher } from "./harness";
import {
  sendNotification,
  DEFAULT_NOTIFICATION_CHANNEL,
} from "./notification-channels";
import {
  createTraceId,
  createTrace,
  completeTrace,
} from "./tracing";
import {
  beginRun,
  finishRun,
  finishFromResult,
  finishSkipped,
  failOrchestration,
  reapOrphans,
  evictOldRuns,
  type RunEnvelope,
} from "./job-ledger";
import type { ThreadContext } from "./thread-context";

const POLL_INTERVAL_MS = 30_000; // 30 seconds
// Run eviction roughly hourly rather than every poll — it's a cheap DELETE but
// there's no need to issue it twice a minute.
const EVICT_EVERY_N_POLLS = Math.round((60 * 60 * 1000) / POLL_INTERVAL_MS);
let running = false;
let pollCount = 0;

/**
 * Start the scheduler polling loop.
 * Safe to call multiple times — only starts once.
 */
export function startScheduler(): void {
  if (running) return;
  running = true;

  console.log(`[Scheduler] Started (polling every ${POLL_INTERVAL_MS / 1000}s)`);

  setInterval(async () => {
    // Ledger maintenance runs every poll regardless of due jobs: the orphan
    // reaper is the only thing that catches a run whose process died mid-flight
    // (no code path survives to call finishRun), and eviction keeps the 7-day
    // window. Both are best-effort — a failure here must not stop the poller.
    try {
      const reaped = await reapOrphans();
      if (reaped > 0) console.log(`[Scheduler] Reaped ${reaped} orphaned run(s)`);
    } catch (err) {
      console.error("[Scheduler] Orphan reap error:", err);
    }
    if (pollCount % EVICT_EVERY_N_POLLS === 0) {
      try {
        const evicted = await evictOldRuns();
        if (evicted > 0) console.log(`[Scheduler] Evicted ${evicted} old run(s)`);
      } catch (err) {
        console.error("[Scheduler] Run eviction error:", err);
      }
    }
    pollCount++;

    try {
      const dueJobs = await getDueJobs();
      if (dueJobs.length === 0) return;

      for (const job of dueJobs) {
        console.log(`[Scheduler] Firing job: ${job.id} (agent: ${job.agentId}, profile: ${job.profile ?? "default"})`);

        // Mark as fired first (prevents re-firing on slow runs)
        await markJobFired(job.id);

        // Fire async — don't block the poller. executeJob takes a per-agent
        // active-run lock: if a run for this agent+profile is still in flight
        // (long run, or a manual "run now"), this occurrence is skipped rather
        // than run concurrently and clobber the shared workspace.
        executeJob(job, { source: "scheduler" })
          .then((result) => {
            if (result.skipped) {
              console.log(`[Scheduler] Job ${job.id} skipped: ${result.error}`);
            }
          })
          .catch(async (err) => {
            const error = err instanceof Error ? err.message : String(err);
            console.error(`[Scheduler] Job ${job.id} failed:`, error);
            await notifyFailure(job, error);
          });
      }
    } catch (err) {
      console.error("[Scheduler] Poll error:", err);
    }
  }, POLL_INTERVAL_MS);
}

/** How a job execution was initiated. */
export type JobSource = "scheduler" | "trigger";

export interface ExecuteJobResult {
  success: boolean;
  /** Final agent output text, for "run" jobs. */
  rawText?: string;
  error?: string;
  /**
   * True when the job did not run because another run for the same agent was
   * already active (concurrency lock not acquired). Not a failure — the
   * caller should treat this as "try again later".
   */
  skipped?: boolean;
  /** The job-run ledger id for this execution (for linking replays). */
  runId?: string;
}

/** Active-run lock key: one in-flight agent run per agent+profile. */
function runLockKey(job: ScheduledJob): string {
  return `${job.agentId}:${job.profile ?? "default"}`;
}

/**
 * Whether an agent run for this job's agent is currently in flight. Notify jobs
 * take no lock, so they are never "active". Advisory (non-atomic) — the real
 * guard is the atomic acquire inside executeJob; this exists so callers can
 * give immediate "already running" feedback before firing a long run.
 */
export async function isJobActive(job: ScheduledJob): Promise<boolean> {
  if (job.action === "notify") return false;
  return isRunActive(runLockKey(job));
}

/**
 * Build the source-task facts attached to any email thread this run creates,
 * so a reply can be traced back to the task (and acted on). Just facts — the
 * agent decides what to do from them.
 */
function buildThreadContext(job: ScheduledJob, source: JobSource): ThreadContext {
  return {
    taskId: job.id,
    description: job.description,
    schedule: job.cron,
    // A manual "run now" has no scheduled fire time. For scheduled fires,
    // job.nextRun is still this run's due time here (the poller's in-memory job
    // isn't mutated by markJobFired).
    scheduledTime: source === "trigger" ? undefined : new Date(job.nextRun).toISOString(),
    runTime: new Date().toISOString(),
  };
}

/**
 * Execute a job's payload — shared by the scheduler poller and manual "run now"
 * triggers.
 *
 * This does NOT touch the schedule (no markJobFired). The poller reschedules /
 * consumes the job before calling this; the trigger path leaves recurring
 * schedules intact and consumes one-shots itself.
 *
 * Behavior that depends on `source`:
 *   - The agent's requested next-run override is only honored for "scheduler"
 *     runs — a manual trigger must not shift the schedule.
 *   - Failure notifications are only pushed to the job's channel for
 *     "scheduler" runs; manual triggers surface the error to the caller (UI)
 *     instead of spamming the channel.
 *
 * "run" (agent) jobs take an active-run lock so a manual trigger can't overlap
 * a scheduled fire (or another trigger) for the same agent and clobber the
 * shared workspace. "notify" jobs have no such lock (no agent workspace).
 */
export async function executeJob(
  job: ScheduledJob,
  opts: { source: JobSource; replayOf?: string }
): Promise<ExecuteJobResult> {
  // Open the ledger row before anything runs, carrying the full job snapshot as
  // the replay envelope — so this occurrence is replayable even if the process
  // dies mid-run (the reaper will later flip it to failed/orphaned). The trace
  // id is stamped now too so hook activity can renew the run's lease.
  const traceId = createTraceId();
  const envelope: RunEnvelope = { source: opts.source, job };
  const runId = await beginRun(envelope, {
    agentId: job.agentId,
    profile: job.profile,
    label: jobLabel(job),
    traceId,
    replayOf: opts.replayOf,
  });

  try {
    if (job.action === "notify") {
      const result = await executeNotifyJob(job, opts.source);
      if (result.success) {
        await finishRun(runId, { status: "succeeded" });
      } else {
        await finishRun(runId, {
          status: "failed",
          failureClass: "orchestration",
          error: result.error,
        });
      }
      return { ...result, runId };
    }

    const lockKey = runLockKey(job);
    const acquired = await acquireActiveRun(lockKey);
    if (!acquired) {
      // A one-shot (no cron) occurrence is lost when skipped, so it's recorded
      // as a replayable failure; a recurring one just fires again next tick.
      await finishSkipped(runId, !job.cron);
      return {
        success: false,
        skipped: true,
        error: `A run is already in progress for ${lockKey}`,
        runId,
      };
    }

    try {
      await createTrace(traceId, job.agentId, {
        trigger: opts.source,
        jobId: job.id,
        profile: job.profile,
      });

    // Scheduled/triggered runs are the household's own automations (the
    // initiator is the authenticated owner, not an external sender), so they
    // run at household trust by default — otherwise every household-gated
    // capability (email, gmail, notion, calendar) is filtered out. A job
    // can pin itself to "guest" for least privilege.
    const trustTier = job.trustTier ?? "household";

    // Attached to any email thread the run creates (via env → email-mcp →
    // control API), so a reply can be traced back to this task.
    const threadContext = buildThreadContext(job, opts.source);

    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: job.agentId,
      profile: job.profile,
      identity: {
        trustTier,
        senderIdentity: "Automated run (no external sender)",
        originChannel: opts.source === "trigger" ? "manual-trigger" : "schedule",
      },
      prompt: (job.params?.prompt as string) ?? "Run.",
      context: {
        currentTime: currentTimePST(),
      },
      additionalEnv: {
        NORTHSTAR_TRACE_ID: traceId,
        NORTHSTAR_THREAD_CONTEXT: JSON.stringify(threadContext),
      },
    });

    // Auto-reschedule: agent output can override the cron-computed next run.
    // Only for scheduled runs — a manual trigger must not shift the schedule.
    if (opts.source === "scheduler") {
      const nextMinutes = result.output?.nextCheckInTime as number | undefined;
      if (nextMinutes && job.cron) {
        const nextTime = new Date(Date.now() + nextMinutes * 60 * 1000);
        try {
          await overrideNextRun(job.id, nextTime);
          console.log(`[Scheduler] Agent requested next run in ${nextMinutes}m — overriding cron for job ${job.id}`);
        } catch (err) {
          console.error(`[Scheduler] Failed to override next run for ${job.id}:`, err);
        }
      }
    }

    await completeTrace(traceId, {
      success: result.success,
      error: result.error,
    });

    // Push failure to the job's channel only for scheduled runs; manual
    // triggers report the error back through the return value.
    if (!result.success && opts.source === "scheduler") {
      await notifyFailure(job, result.error || "Unknown error");
    }

    await finishFromResult(runId, job.agentId, result);

    return {
      success: result.success,
      rawText: result.rawText,
      error: result.error,
      runId,
    };
    } finally {
      await clearActiveRun(lockKey);
    }
  } catch (err) {
    // A throw around the launch (createTrace, launcher, DB) — record it as an
    // orchestration failure so the occurrence is still visible and replayable.
    const error = err instanceof Error ? err.message : String(err);
    await failOrchestration(runId, error);
    throw err;
  }
}

/** One-liner label for the Runs list. */
function jobLabel(job: ScheduledJob): string {
  return (
    job.description ??
    `${job.agentId}${job.profile ? `:${job.profile}` : ""}${
      job.action === "notify" ? " (notify)" : ""
    }`
  );
}

/**
 * Execute a notification job — send a message to the configured channel.
 */
async function executeNotifyJob(job: ScheduledJob, source: JobSource): Promise<ExecuteJobResult> {
  const message = job.params?.message as string;
  if (!message) {
    console.error("[Scheduler] Notify job has no message:", job.id);
    return { success: false, error: "Notify job has no message" };
  }

  const channel = job.notificationChannel ?? DEFAULT_NOTIFICATION_CHANNEL;
  const from = job.params?.from as string | undefined;

  try {
    await sendNotification(channel, {
      message,
      from,
      recipient: job.notificationRecipient,
      // Only meaningful for the email channel; harmless elsewhere.
      threadContext: buildThreadContext(job, source),
    });
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduler] Failed to send notify job ${job.id} via ${channel}:`, error);
    return { success: false, error };
  }
}

/**
 * Send a failure notification on the job's configured channel.
 */
async function notifyFailure(job: ScheduledJob, error: string): Promise<void> {
  const channel = job.notificationChannel ?? DEFAULT_NOTIFICATION_CHANNEL;
  const label = job.description ?? `${job.agentId}${job.profile ? `:${job.profile}` : ""}`;
  const message = `:warning: *Scheduled job failed:* ${label}\n\`\`\`${error.substring(0, 500)}\`\`\``;

  try {
    await sendNotification(channel, {
      message,
      recipient: job.notificationRecipient,
      subject: `Job failed: ${label}`,
    });
  } catch (err) {
    console.error(`[Scheduler] Failed to deliver failure notification for ${job.id} via ${channel}:`, err);
  }
}
