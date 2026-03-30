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
        fireJob(job).catch((err) => {
          console.error(`[Scheduler] Job ${job.id} failed:`, err);
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
  const orchestrator = getOrchestrator(job.agentId, job.profile);

  if (orchestrator) {
    await orchestrator({
      prompt: (job.params?.prompt as string) ?? undefined,
      ...job.params,
    });
  } else {
    // No orchestrator — launch directly
    const launcher = getLauncher();
    await launcher.launch({
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
  }
}
