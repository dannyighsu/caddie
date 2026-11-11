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
  deferRecurringJob,
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
import { workspace } from "./harness";
import {
  notifyJobFailure,
  noteJobSuccess,
} from "./job-failure-alerts";
import {
  parseCommandSpec,
  runCommand,
  buildFollowupPrompt,
  describeResult,
  type CommandSpec,
  type CommandResult,
} from "./command-job";

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
        console.log(`[Scheduler] Firing job: ${job.id} (profile: ${job.profile ?? "default"})`);

        // Mark as fired first (prevents re-firing on slow runs)
        await markJobFired(job.id);

        // Fire async — don't block the poller. executeJob takes a per-profile
        // active-run lock: if a run for this profile is still in flight
        // (long run, or a manual "run now"), this occurrence is deferred a few
        // minutes rather than run concurrently and clobber the shared
        // workspace.
        executeJob(job, { source: "scheduler" })
          .then((result) => {
            if (result.skipped) {
              console.log(`[Scheduler] Job ${job.id} skipped: ${result.error}`);
            }
          })
          .catch(async (err) => {
            const error = err instanceof Error ? err.message : String(err);
            console.error(`[Scheduler] Job ${job.id} failed:`, error);
            await notifyJobFailure(job, error);
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
   * True when the job did not run because another run for the same profile was
   * already active (concurrency lock not acquired). Not a failure — a recurring
   * occurrence has been deferred to a later time (see `error` for when), and a
   * manual trigger should simply be retried.
   */
  skipped?: boolean;
  /** The job-run ledger id for this execution (for linking replays). */
  runId?: string;
}

/** Active-run lock key: one in-flight agent run per profile. */
function runLockKey(job: ScheduledJob): string {
  return job.profile ?? "default";
}

/**
 * Whether an agent run for this job's profile is currently in flight. Notify and
 * command jobs take no lock to do their own work, so they are never "active" —
 * a command job only takes the lock if its output goes on to wake the agent,
 * and that is decided after the command has run. Advisory (non-atomic) — the
 * real guard is the atomic acquire inside executeJob; this exists so callers can
 * give immediate "already running" feedback before firing a long run.
 */
export async function isJobActive(job: ScheduledJob): Promise<boolean> {
  if (job.action === "notify" || job.action === "command") return false;
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
 * a scheduled fire (or another trigger) for the same profile and clobber the
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
    profile: job.profile,
    label: jobLabel(job),
    traceId,
    replayOf: opts.replayOf,
  });

  try {
    const result = await runJobAction(job, opts, runId, traceId);
    // A scheduled occurrence that came back clean closes any failure streak —
    // and says so if alerts went out about it. Skipped occurrences are neither
    // success nor failure, so they leave the streak alone.
    if (opts.source === "scheduler" && result.success && !result.skipped) {
      await noteJobSuccess(job);
    }
    return result;
  } catch (err) {
    // A throw around the launch (createTrace, launcher, DB) — record it as an
    // orchestration failure so the occurrence is still visible and replayable.
    const error = err instanceof Error ? err.message : String(err);
    await failOrchestration(runId, error);
    throw err;
  }
}

/** Dispatch a job to the executor for its action. */
async function runJobAction(
  job: ScheduledJob,
  opts: { source: JobSource; replayOf?: string },
  runId: string,
  traceId: string
): Promise<ExecuteJobResult> {
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

  if (job.action === "command") {
    return await executeCommandJob(job, opts, runId, traceId);
  }

  return await runAgentJob(job, opts, runId, traceId);
}

/**
 * Launch the agent for a job, under the per-profile active-run lock.
 *
 * Split out of `executeJob` so a command job can reuse it: a command job that
 * produced output needs exactly this path, with the output folded into the
 * prompt (`promptOverride`), including the lock and the deferral behavior.
 */
async function runAgentJob(
  job: ScheduledJob,
  opts: { source: JobSource; replayOf?: string },
  runId: string,
  traceId: string,
  promptOverride?: string
): Promise<ExecuteJobResult> {
  const lockKey = runLockKey(job);
  const acquired = await acquireActiveRun(lockKey);
  if (!acquired) {
    // A one-shot (no cron) occurrence is lost when skipped, so it's recorded
    // as a replayable failure. A recurring one is deferred a couple of
    // minutes so it still runs: the poller already called markJobFired, which
    // advanced nextRun to the next natural occurrence, so leaving it alone
    // would silently drop this occurrence rather than retry it. Only for
    // scheduled fires — a manual trigger must not shift the schedule.
    const deferredTo =
      job.cron && opts.source === "scheduler"
        ? await deferRecurringJob(job.id)
        : null;
    const busy = `A run is already in progress for ${lockKey}`;
    if (deferredTo) {
      console.log(
        `[Scheduler] Job ${job.id} deferred to ${deferredTo.toISOString()} — ${busy}`
      );
    }
    await finishSkipped(
      runId,
      !job.cron,
      deferredTo
        ? `${busy}; occurrence deferred to ${deferredTo.toISOString()}.`
        : `${busy}; not deferred (next scheduled occurrence is already due).`
    );
    return {
      success: false,
      skipped: true,
      error: deferredTo
        ? `${busy} — deferred to ${deferredTo.toISOString()}`
        : busy,
      runId,
    };
  }

  try {
    await createTrace(traceId, {
      trigger: opts.source,
      jobId: job.id,
      profile: job.profile,
    });

  // Scheduled/triggered runs are the team's own automations (the
  // initiator is the authenticated owner, not an external sender), so they
  // run at team trust by default — otherwise every team-gated
  // capability (email, gmail, notion, calendar) is filtered out. A job
  // can pin itself to "guest" for least privilege.
  const trustTier = job.trustTier ?? "team";

  // Attached to any Slack or email thread the run creates (via env → egress/
  // email MCP → control API), so a reply can be traced back to this task.
  const threadContext = buildThreadContext(job, opts.source);

  // Per-job key. An explicit params.stateKey wins; otherwise derive it from a
  // leading slash-command in the prompt (e.g. "/golf-tee-times" ->
  // "golf-tee-times"), so the launcher injects the job's instructions
  // (jobs/<key>.md — the procedure) and state (state/<key>.md — carried
  // directives/pauses), and the run starts with both already in context.
  const promptStr = (job.params?.prompt as string) ?? "";
  const slashMatch = promptStr.match(/^\/([a-z0-9][a-z0-9-]*)/i);
  const stateKey = (job.params?.stateKey as string | undefined) ?? slashMatch?.[1];

  const launcher = getLauncher();
  const result = await launcher.launch({
    profile: job.profile,
    stateKey,
    identity: {
      trustTier,
      senderIdentity: "Automated run (no external sender)",
      originChannel: opts.source === "trigger" ? "manual-trigger" : "schedule",
    },
    prompt: promptOverride ?? (job.params?.prompt as string) ?? "Run.",
    context: {
      currentTime: currentTimePST(),
    },
    additionalEnv: {
      CADDIE_TRACE_ID: traceId,
      CADDIE_THREAD_CONTEXT: JSON.stringify(threadContext),
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
    await notifyJobFailure(job, result.error || "Unknown error");
  }

  await finishFromResult(runId, result);

  return {
    success: result.success,
    rawText: result.rawText,
    error: result.error,
    runId,
  };
  } finally {
    await clearActiveRun(lockKey);
  }
}

/** One-liner label for the Runs list. */
function jobLabel(job: ScheduledJob): string {
  return job.description ?? job.id;
}

/**
 * Execute a command job — run one shell command, then decide from its output.
 *
 * This is the cheap-poll path: the common case is a command that prints nothing,
 * which costs a subprocess and ends the occurrence right there. Only output
 * escalates, per the job's `onOutput`:
 *   - "run"    — hand the output to the agent via `runAgentJob` (takes the lock).
 *   - "notify" — post the output to the job's notification channel.
 *   - "ignore" — log it.
 *
 * A non-zero exit, a timeout or a spawn failure is a job failure and is reported
 * like any other scheduled failure, regardless of what stdout held. Note the
 * ordering: the command's own exit status is checked first, so a poller that
 * prints lines *and* then fails is treated as a failure rather than quietly
 * waking the agent with partial output.
 */
async function executeCommandJob(
  job: ScheduledJob,
  opts: { source: JobSource; replayOf?: string },
  runId: string,
  traceId: string
): Promise<ExecuteJobResult> {
  let spec: CommandSpec;
  try {
    spec = parseCommandSpec(job.params, workspace);
  } catch (err) {
    // A malformed spec is a permanent error — the job will fail identically on
    // every tick, so make it loud rather than silently doing nothing.
    const error = `Invalid command job: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[Scheduler] ${error} (job ${job.id})`);
    await finishRun(runId, { status: "failed", failureClass: "orchestration", error });
    if (opts.source === "scheduler") await notifyJobFailure(job, error);
    return { success: false, error, runId };
  }

  const result = await runCommand(spec);
  console.log(
    `[Scheduler] Command job ${job.id}: ${describeResult(result)} (onOutput: ${spec.onOutput})`
  );

  const failure = commandFailure(spec, result);
  if (failure) {
    await finishRun(runId, {
      status: "failed",
      failureClass: "orchestration",
      error: failure,
    });
    if (opts.source === "scheduler") await notifyJobFailure(job, failure);
    return { success: false, error: failure, rawText: result.stdout, runId };
  }

  const output = result.stdout.trim();
  if (output === "") {
    // The quiet tick. Nothing happened, and that is the whole point.
    await finishRun(runId, { status: "succeeded" });
    return { success: true, rawText: "", runId };
  }

  if (spec.onOutput === "run") {
    const prompt = buildFollowupPrompt(
      job.params?.prompt as string,
      spec.command,
      result.stdout
    );
    return await runAgentJob(job, opts, runId, traceId, prompt);
  }

  if (spec.onOutput === "notify") {
    const channel = job.notificationChannel ?? DEFAULT_NOTIFICATION_CHANNEL;
    try {
      await sendNotification(channel, {
        message: output,
        recipient: job.notificationRecipient,
        subject: job.description ?? `Scheduled command: ${job.id}`,
        threadContext: buildThreadContext(job, opts.source),
      });
    } catch (err) {
      const error = `Command succeeded but notification failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      console.error(`[Scheduler] ${error} (job ${job.id})`);
      await finishRun(runId, { status: "failed", failureClass: "orchestration", error });
      // Worth alerting even though the channel is what just failed: the alert
      // path falls back to the owner's email, so this no longer disappears.
      if (opts.source === "scheduler") await notifyJobFailure(job, error);
      return { success: false, error, rawText: result.stdout, runId };
    }
  }

  await finishRun(runId, { status: "succeeded" });
  return { success: true, rawText: result.stdout, runId };
}

/**
 * The failure message for a finished command, or null if it succeeded.
 * stderr is folded in because a failing command's only explanation is usually
 * there, and the notification is all anyone sees of a scheduled run.
 */
function commandFailure(spec: CommandSpec, result: CommandResult): string | null {
  const detail = result.stderr.trim();
  const suffix = detail ? `\n\`\`\`${detail.substring(0, 500)}\`\`\`` : "";
  if (result.spawnError) {
    return `Command failed to start: ${result.spawnError}`;
  }
  if (result.timedOut) {
    return `Command timed out after ${spec.timeoutMs}ms: \`${spec.command}\`${suffix}`;
  }
  if (result.exitCode !== 0) {
    return `Command exited ${result.exitCode ?? "on a signal"}: \`${spec.command}\`${suffix}`;
  }
  return null;
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
      // Registers the outbound thread on Slack and email so a reply carries the
      // source-task facts; ignored by channels without thread registration.
      threadContext: buildThreadContext(job, source),
    });
    return { success: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduler] Failed to send notify job ${job.id} via ${channel}:`, error);
    return { success: false, error };
  }
}
