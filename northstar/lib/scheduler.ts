/**
 * Job Scheduler
 *
 * In-process polling loop that checks Redis for due jobs and fires them.
 * Starts once via instrumentation.ts when the server boots.
 *
 * Recurring jobs re-schedule automatically after firing.
 * One-shot jobs are removed after firing.
 */

import { getDueJobs, markJobFired, type ScheduledJob } from "./redis";
import { getOrchestrator } from "./orchestrators";
import { getLauncher } from "./harness";
import { sendMessage, isSlackConfigured } from "./slack";
import { getSetting } from "./db";

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

  const orchestrator = getOrchestrator(job.agentId, job.profile);

  let result: Record<string, unknown> | undefined;

  if (orchestrator) {
    result = await orchestrator({
      prompt: (job.params?.prompt as string) ?? undefined,
      ...job.params,
    });
  } else {
    const launcher = getLauncher();
    const launchResult = await launcher.launch({
      agentId: job.agentId,
      profile: job.profile,
      prompt: (job.params?.prompt as string) ?? "Run.",
      context: {
        currentTime: new Date().toLocaleString("en-US", {
          timeZone: "America/Los_Angeles",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }),
      },
    });
    result = { success: launchResult.success, error: launchResult.error };
  }

  // Notify on failure
  if (result && !result.success && result.error) {
    await notifyFailure(job, result.error as string);
  }
}

/**
 * Execute a scheduled notification job — send a message to Slack.
 */
async function fireNotifyJob(job: ScheduledJob): Promise<void> {
  if (!isSlackConfigured()) {
    console.error("[Scheduler] Cannot fire notify job: Slack not configured");
    return;
  }

  const message = job.params?.message as string;
  if (!message) {
    console.error("[Scheduler] Notify job has no message:", job.id);
    return;
  }

  let channelId = job.params?.slackChannel as string | undefined;
  if (!channelId) {
    const defaultChannel = await getSetting<{ channelId: string }>("default_slack_channel");
    channelId = defaultChannel?.channelId;
  }
  if (!channelId) {
    console.error("[Scheduler] No Slack channel for notify job:", job.id);
    return;
  }

  const from = job.params?.from as string | undefined;
  const formatted = from ? `*[${from}]* ${message}` : message;
  await sendMessage(channelId, formatted);
}

/**
 * Send a failure notification to Slack.
 */
async function notifyFailure(job: ScheduledJob, error: string): Promise<void> {
  if (!isSlackConfigured()) return;

  try {
    const defaultChannel = await getSetting<{ channelId: string }>("default_slack_channel");
    const channelId = defaultChannel?.channelId;
    if (!channelId) return;

    const label = job.description ?? `${job.agentId}${job.profile ? `:${job.profile}` : ""}`;
    await sendMessage(
      channelId,
      `:warning: *Scheduled job failed:* ${label}\n\`\`\`${error.substring(0, 500)}\`\`\``
    );
  } catch {
    // Best effort
  }
}
