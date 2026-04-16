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

import { getDueJobs, markJobFired, overrideNextRun, type ScheduledJob } from "./redis";
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

const POLL_INTERVAL_MS = 30_000; // 30 seconds
let running = false;

/**
 * Start the scheduler polling loop.
 * Safe to call multiple times — only starts once.
 */
export function startScheduler(): void {
  if (running) return;
  running = true;

  console.log(`[Scheduler] Started (polling every ${POLL_INTERVAL_MS / 1000}s)`);

  setInterval(async () => {
    try {
      const dueJobs = await getDueJobs();
      if (dueJobs.length === 0) return;

      for (const job of dueJobs) {
        console.log(`[Scheduler] Firing job: ${job.id} (agent: ${job.agentId}, profile: ${job.profile ?? "default"})`);

        // Mark as fired first (prevents re-firing on slow runs)
        await markJobFired(job.id);

        // Fire async — don't block the poller
        fireJob(job).catch(async (err) => {
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

/**
 * Execute a scheduled job.
 */
async function fireJob(job: ScheduledJob): Promise<void> {
  // Handle notification jobs
  if (job.action === "notify") {
    await fireNotifyJob(job);
    return;
  }

  const traceId = createTraceId();
  await createTrace(traceId, job.agentId, {
    trigger: "scheduler",
    jobId: job.id,
    profile: job.profile,
  });

  const launcher = getLauncher();
  const result = await launcher.launch({
    agentId: job.agentId,
    profile: job.profile,
    prompt: (job.params?.prompt as string) ?? "Run.",
    context: {
      currentTime: currentTimePST(),
    },
    additionalEnv: { NORTHSTAR_TRACE_ID: traceId },
  });

  // Auto-reschedule: agent output can override the cron-computed next run
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

  await completeTrace(traceId, {
    success: result.success,
    error: result.error,
  });

  // Notify on failure
  if (!result.success) {
    await notifyFailure(job, result.error || "Unknown error");
  }
}

/**
 * Execute a scheduled notification job — send a message to the configured channel.
 */
async function fireNotifyJob(job: ScheduledJob): Promise<void> {
  const message = job.params?.message as string;
  if (!message) {
    console.error("[Scheduler] Notify job has no message:", job.id);
    return;
  }

  const channel = job.notificationChannel ?? DEFAULT_NOTIFICATION_CHANNEL;
  const from = job.params?.from as string | undefined;

  try {
    await sendNotification(channel, {
      message,
      from,
      recipient: job.notificationRecipient,
    });
  } catch (err) {
    console.error(`[Scheduler] Failed to send notify job ${job.id} via ${channel}:`, err);
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
