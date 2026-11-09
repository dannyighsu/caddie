/**
 * Job Failure Alerts
 *
 * A scheduled job that fails writes a ledger row, and until this module existed
 * that was *all* it did when its notification channel couldn't deliver: the
 * scheduler's push was wrapped in a try/catch whose only consequence was a
 * `console.error` nobody reads. A job with `notificationChannel: "slack"` and no
 * `notificationRecipient` resolves its channel from the `default_slack_channel`
 * setting — and when that setting is unset, every failure notification for every
 * job throws there. A 5-minute poller failed on every tick for five days and
 * looked, from the outside, exactly like a poller finding nothing.
 *
 * Two things are needed to make a failure audible, and they pull against each
 * other:
 *
 *   1. **Delivery that doesn't depend on one channel.** If the job's channel
 *      can't take the message, the alert falls back to emailing the team owner
 *      (`owner-alert`). An alert is only recorded as delivered if some path
 *      actually took it, so a Slack outage means the next tick tries again
 *      instead of marking the streak notified and going quiet.
 *   2. **Throttling.** A five-minute poller that is broken rather than flaky produces
 *      ~130 identical failures a workday. Alerting on each one is its own kind
 *      of silence. So: alert on the first failure, then at most once per
 *      `RE_ALERT_MS` while the *same* failure keeps repeating, and alert again
 *      immediately if the error changes (a different failure is news).
 *
 * A job that comes back clean after an alerted streak gets one short recovery
 * line, so "it's fixed" is as audible as "it broke". A streak nobody was ever
 * told about is cleared silently — announcing the recovery of an unreported
 * problem is just noise.
 *
 * The throttle rules and message text live in `job-failure-streak` (pure, unit
 * tested). This module is the stateful shell: Redis for the carried streak,
 * channel + email for delivery. Both entry points — `notifyJobFailure` and
 * `noteJobSuccess` — are best-effort and never throw: an alerting failure must
 * not mask the job failure it was describing.
 */

import {
  getJobFailureStreak,
  setJobFailureStreak,
  clearJobFailureStreak,
  type ScheduledJob,
} from "./redis";
import {
  sendNotification,
  DEFAULT_NOTIFICATION_CHANNEL,
} from "./notification-channels";
import { emailOwner } from "./owner-alert";
import { agentName } from "./agent-name";
import {
  recordFailure,
  markNotified,
  formatFailureAlert,
  formatRecoveryAlert,
  formatFallbackEmail,
  MAX_ERROR_CHARS,
  type AlertDecision,
  type FailureStreak,
} from "./job-failure-streak";

export type { FailureStreak, AlertDecision };

/**
 * Deliver one alert: the job's channel first, the owner's email if that fails.
 * Returns true if either path took it.
 */
async function deliver(
  job: ScheduledJob,
  label: string,
  message: string,
  subject: string
): Promise<boolean> {
  const channel = job.notificationChannel ?? DEFAULT_NOTIFICATION_CHANNEL;
  try {
    await sendNotification(channel, {
      message,
      recipient: job.notificationRecipient,
      subject,
    });
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[JobAlerts] ${channel} could not take the alert for ${job.id}: ${detail}` +
        ` — falling back to the owner's email.`
    );
    return await emailOwner(
      `⚠️ ${agentName()}: ${subject}`,
      formatFallbackEmail(label, message, channel, detail)
    );
  }
}

function jobLabel(job: ScheduledJob): string {
  return job.description ?? job.id;
}

/**
 * Record a scheduled job's failure and alert if the throttle allows it.
 * Best-effort: never throws.
 */
export async function notifyJobFailure(
  job: ScheduledJob,
  error: string
): Promise<void> {
  const label = jobLabel(job);
  try {
    const prev = await getJobFailureStreak(job.id);
    const decision = recordFailure(prev, error, Date.now());

    if (!decision.notify) {
      await setJobFailureStreak(job.id, decision.streak);
      console.log(
        `[JobAlerts] ${job.id} failed again (#${decision.streak.count}, same error) — ` +
          `alert suppressed until the quiet period elapses.`
      );
      return;
    }

    const message = formatFailureAlert(label, decision);
    const delivered = await deliver(job, label, message, `Job failed: ${label}`);
    await setJobFailureStreak(
      job.id,
      delivered ? markNotified(decision.streak) : decision.streak
    );
    if (!delivered) {
      console.error(
        `[JobAlerts] No path accepted the failure alert for ${job.id}; ` +
          `will retry on the next failure.`
      );
    }
  } catch (err) {
    // Includes a Redis outage: losing the throttle state must not lose the
    // alert, so fall back to an unthrottled push on the job's channel.
    console.error(`[JobAlerts] Alerting path failed for ${job.id}:`, err);
    await deliver(
      job,
      label,
      `:warning: *Scheduled job failed:* ${label}\n\`\`\`${error.substring(0, MAX_ERROR_CHARS)}\`\`\``,
      `Job failed: ${label}`
    ).catch(() => {});
  }
}

/**
 * Record a scheduled job's success: clears any carried streak and, if alerts
 * went out about it, says it's back. Best-effort: never throws.
 */
export async function noteJobSuccess(job: ScheduledJob): Promise<void> {
  try {
    const prev = await getJobFailureStreak(job.id);
    if (!prev) return;
    await clearJobFailureStreak(job.id);
    // A streak nobody was told about needs no all-clear.
    if (prev.notifiedCount === 0) return;
    const label = jobLabel(job);
    await deliver(
      job,
      label,
      formatRecoveryAlert(label, prev),
      `Job recovered: ${label}`
    );
  } catch (err) {
    console.error(`[JobAlerts] Could not clear failure streak for ${job.id}:`, err);
  }
}
