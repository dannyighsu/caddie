/**
 * Control API — /api/control
 *
 * The control-plane command surface: an internal API for triggering agent
 * executions, sending notifications, and managing scheduled jobs. Called by the
 * portal UI and by the agent's own tools/skills (never by external senders —
 * inbound channel traffic arrives at the webhook routes instead). See
 * docs/BACKEND.md for the API server's client classes.
 *
 * Actions:
 *   notify  — Send a message to Slack, Telegram, or email (immediately or scheduled)
 *   run     — Execute an agent (immediately or scheduled)
 *   schedule — Create a recurring job
 *
 * Supports `scheduledFor` for one-shot deferred execution,
 * or `cron` for recurring jobs.
 *
 * Examples:
 *   curl -X POST localhost:3000/api/control -d '{"action":"notify","channel":"slack","message":"done"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"notify","channel":"telegram","to":"123456789","message":"done"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri","profile":"xmanager"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri","scheduledFor":"2026-03-28T09:00:00Z"}'
 *   curl -X POST localhost:3000/api/control -d '{"action":"schedule","agentId":"buri","profile":"xmanager","cron":"0,30 * * * *","description":"Feed scan every 30 min"}'
 */

import { NextRequest, NextResponse } from "next/server";
import { sendMessage, replyInThread, recordOutboundSlackThread, isSlackConfigured } from "@/lib/slack";
import { sendTelegramMessage, isTelegramConfigured } from "@/lib/telegram";
import { sendEmail, replyToEmail, recordEmailReply, isEmailConfigured } from "@/lib/email";
import type { NotificationChannel } from "@/lib/notification-channels";
import type { ReplyTarget } from "@/lib/messaging";
import { portalIdentity, toRunIdentity, parsePortalOwner, type TrustTier, type UserId } from "@/lib/identity";
import type { ThreadContext } from "@/lib/thread-context";
import { getLauncher } from "@/lib/harness";
import { getSetting, appendAssistantReply } from "@/lib/db";
import { currentTimePST } from "@/lib/helpers";
import { scheduleOneShot, scheduleRecurring, scheduleNotification, listJobs, deleteJob, getJob, upsertJob } from "@/lib/redis";
import { executeJob, isJobActive } from "@/lib/scheduler";
import { createTraceId, createTrace, completeTrace } from "@/lib/tracing";

interface ControlRequest {
  action: "notify" | "reply" | "run" | "schedule" | "update_schedule" | "trigger";

  // --- reply fields ---
  /**
   * Where to deliver the reply, injected into the run as NORTHSTAR_REPLY_TARGET
   * and forwarded verbatim by the reply MCP tool. Not agent-supplied, so a reply
   * can only land in the current conversation. Uses `message` for the body.
   */
  replyTarget?: ReplyTarget;
  /**
   * Email reply scope. Defaults to reply-all (true) when omitted, so group
   * threads stay group threads; the agent sets `false` to answer just the
   * sender. Ignored for non-email channels, which have no CC concept.
   */
  replyAll?: boolean;

  // --- notify fields ---
  channel?: NotificationChannel;
  message?: string;
  from?: string;
  slackChannel?: string;
  threadTs?: string;
  /** Telegram chat ID (numeric string) or email address */
  to?: string;
  /** Email subject line */
  subject?: string;
  /**
   * Source-task facts to attach to the email thread this send creates (email
   * channel only). Forwarded by email-mcp from the run's NORTHSTAR_THREAD_CONTEXT.
   */
  threadContext?: ThreadContext;

  // --- run fields ---
  agentId?: string;
  profile?: string;
  prompt?: string;
  context?: Record<string, string>;
  /**
   * Trust tier for scheduled/one-shot agent runs. Defaults to "household" at
   * execution time (these are the household's own automations). Set "guest" to
   * pin a job to least privilege.
   */
  trustTier?: TrustTier;

  // --- scheduling ---
  scheduledFor?: string;    // ISO timestamp for one-shot deferred execution
  cron?: string;            // Cron expression for recurring jobs
  jobId?: string;           // For deleting a job
  description?: string;
  /**
   * For scheduled run/notify jobs: the channel to deliver the result/notification on.
   * Defaults to "slack". Set to "telegram" or "email" to override.
   */
  notificationChannel?: NotificationChannel;
  /**
   * For scheduled jobs: channel-specific recipient override (Slack channel ID,
   * Telegram chat ID, or email). If omitted, uses the channel's configured default.
   */
  notificationRecipient?: string;
}

// --- Action execution ---

async function executeAction(req: ControlRequest, portalOwner: UserId): Promise<Record<string, unknown>> {
  switch (req.action) {
    case "notify":
      return executeNotify(req);
    case "reply":
      return executeReply(req);
    case "run":
      return executeRun(req, portalOwner);
    case "schedule":
      return executeSchedule(req);
    case "update_schedule":
      return executeUpdateSchedule(req);
    case "trigger":
      return executeTrigger(req);
    default:
      return { success: false, error: `Unknown action: ${req.action}` };
  }
}

/**
 * Deliver an agent's reply into the current conversation.
 *
 * Unlike `notify`/`send_email` (which start or address arbitrary threads), reply
 * targets the exact conversation the run is handling — the target is injected by
 * the harness (NORTHSTAR_REPLY_TARGET), not chosen by the agent, so a reply can
 * only land where the inbound message came from. On success it records the sent
 * turn locally so replayed history mirrors the real thread.
 */
async function executeReply(req: ControlRequest): Promise<Record<string, unknown>> {
  const target = req.replyTarget;
  const message = req.message;
  if (!target || !message) {
    return { success: false, error: "reply requires `replyTarget` and `message`" };
  }

  // Best-effort local record — a failed record must not fail the delivery.
  const record = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      console.error(`[Control] reply delivered but failed to record locally:`, err);
    }
  };

  switch (target.channel) {
    case "email": {
      if (!isEmailConfigured()) return { success: false, error: "email is not configured" };
      if (!target.email?.messageId) {
        return { success: false, error: "reply target is missing email.messageId" };
      }
      const sent = await replyToEmail(target.email.messageId, message, {
        replyAll: req.replyAll,
      });
      await record(() => recordEmailReply(target.externalId, sent.messageId, message));
      return { success: true, messageId: sent.messageId };
    }
    case "slack": {
      if (!isSlackConfigured()) return { success: false, error: "slack is not configured" };
      if (!target.slack) return { success: false, error: "reply target is missing slack handle" };
      await replyInThread(target.slack.channel, target.slack.threadTs, message);
      await record(() => appendAssistantReply(target.externalId, message));
      return { success: true };
    }
    case "telegram": {
      if (!isTelegramConfigured()) return { success: false, error: "telegram is not configured" };
      if (!target.telegram) return { success: false, error: "reply target is missing telegram handle" };
      await sendTelegramMessage(
        target.telegram.chatId,
        message,
        target.telegram.replyToMessageId
          ? { replyToMessageId: target.telegram.replyToMessageId }
          : undefined,
      );
      await record(() => appendAssistantReply(target.externalId, message));
      return { success: true };
    }
    default:
      return { success: false, error: `reply not supported for channel: ${target.channel}` };
  }
}

/**
 * Trigger an existing scheduled job to run immediately ("run now").
 *
 * Runs the job's stored payload out-of-band via the shared executor. The
 * schedule is preserved: recurring jobs keep their cron/nextRun untouched (this
 * is an EXTRA fire), while one-shot jobs are consumed (deleted) after running
 * so they don't also fire at their scheduled time.
 *
 * If a run for the same agent is already in progress, the job is not run and
 * the caller is told to retry later.
 */
async function executeTrigger(req: ControlRequest): Promise<Record<string, unknown>> {
  if (!req.jobId) {
    return { success: false, error: "jobId is required for trigger" };
  }

  const job = await getJob(req.jobId);
  if (!job) {
    return { success: false, error: `Job not found: ${req.jobId}` };
  }

  // Immediate "already running" feedback so we don't fire (or consume a
  // one-shot) while a run for the same agent is in flight.
  if (await isJobActive(job)) {
    return { success: false, skipped: true, error: "A run is already in progress for this agent" };
  }

  // One-shot jobs are consumed (deleted) once they run, so they don't also fire
  // at their scheduled time. Recurring jobs stay on their schedule — a manual
  // trigger is just an extra run.
  const consumed = !job.cron;

  // Notify jobs are fast — run inline and report the result.
  if (job.action === "notify") {
    const result = await executeJob(job, { source: "trigger" });
    if (result.success && consumed) {
      await deleteJob(job.id);
    }
    return { success: result.success, error: result.error, consumed: result.success && consumed };
  }

  // Agent "run" jobs can take minutes — fire async so the request returns
  // promptly (mirrors how the scheduler fires). Consume a one-shot only after
  // it actually ran (not if the concurrency lock was lost in the meantime).
  executeJob(job, { source: "trigger" })
    .then(async (result) => {
      if (result.skipped) {
        console.log(`[Control] Trigger ${job.id} skipped: ${result.error}`);
        return;
      }
      if (consumed) {
        await deleteJob(job.id);
      }
    })
    .catch((err) => {
      const error = err instanceof Error ? err.message : String(err);
      console.error(`[Control] Trigger ${job.id} failed:`, error);
    });

  return { success: true, started: true, recurring: !!job.cron, consumed };
}

async function executeNotify(req: ControlRequest): Promise<Record<string, unknown>> {
  if (!req.message) {
    return { success: false, error: "message is required" };
  }

  // Handle deferred notification
  if (req.scheduledFor) {
    const runAt = new Date(req.scheduledFor);
    if (isNaN(runAt.getTime())) {
      return { success: false, error: "Invalid scheduledFor timestamp" };
    }
    // Channel for scheduled notify: prefer notificationChannel, fall back to channel, default slack
    const notificationChannel = req.notificationChannel ?? req.channel;
    // Recipient resolution: notificationRecipient > channel-specific (slackChannel/to) > none
    const notificationRecipient =
      req.notificationRecipient ??
      (notificationChannel === "slack" ? req.slackChannel : undefined) ??
      (notificationChannel === "telegram" || notificationChannel === "email"
        ? req.to
        : undefined);

    // Validate up front, mirroring the immediate-send paths below. Email has no
    // default recipient, so a missing one can never be resolved at fire time —
    // reject now instead of accepting the job and failing later in the scheduler.
    if (notificationChannel === "email" && !notificationRecipient) {
      return { success: false, error: "Email recipient (to) is required" };
    }

    const job = await scheduleNotification(runAt, {
      message: req.message,
      from: req.from,
      description: req.description,
      notificationChannel,
      notificationRecipient,
    });
    return { success: true, scheduled: true, jobId: job.id, nextRun: new Date(job.nextRun).toISOString() };
  }

  if (req.channel === "slack" || !req.channel) {
    if (!isSlackConfigured()) {
      return { success: false, error: "SLACK_BOT_TOKEN not configured" };
    }

    let channelId = req.slackChannel;
    if (!channelId) {
      const defaultChannel = await getSetting<{ channelId: string }>("default_slack_channel");
      channelId = defaultChannel?.channelId;
    }
    if (!channelId) {
      return { success: false, error: "No Slack channel specified and no default configured" };
    }

    const formatted = req.from
      ? `*[${req.from}]* ${req.message}`
      : req.message;

    // Resolve the thread root: the parent thread_ts when replying into an
    // existing thread, otherwise the new top-level message's own ts. Register it
    // so a reply in this thread matches a conversation and — for posts from the
    // agent's own tasks — carries the source-task facts (see recordOutboundSlackThread).
    let threadTs = req.threadTs;
    if (threadTs) {
      await replyInThread(channelId, threadTs, formatted);
    } else {
      threadTs = await sendMessage(channelId, formatted);
    }
    if (threadTs) {
      await recordOutboundSlackThread(channelId, threadTs, formatted, req.threadContext);
    }

    return { success: true, channel: "slack", channelId, threadTs };
  }

  if (req.channel === "telegram") {
    if (!isTelegramConfigured()) {
      return { success: false, error: "Telegram not configured (TELEGRAM_BOT_TOKEN missing)" };
    }

    let recipient = req.to;
    if (!recipient) {
      const config = await getSetting<{ defaultRecipient?: string }>("telegram_config");
      recipient = config?.defaultRecipient;
    }
    if (!recipient) {
      return { success: false, error: "No Telegram recipient specified and no default configured" };
    }

    const formatted = req.from
      ? `*[${req.from}]* ${req.message}`
      : req.message;

    await sendTelegramMessage(recipient, formatted);
    return { success: true, channel: "telegram", to: recipient };
  }

  if (req.channel === "email") {
    if (!isEmailConfigured()) {
      return { success: false, error: "Email not configured (missing Google OAuth credentials or token file)" };
    }

    if (!req.to) {
      return { success: false, error: "Email recipient (to) is required" };
    }

    const subject = req.subject ?? "Notification";
    const formatted = req.from
      ? `[${req.from}] ${req.message}`
      : req.message;

    await sendEmail(req.to, subject, formatted, { threadContext: req.threadContext });
    return { success: true, channel: "email", to: req.to };
  }

  return { success: false, error: `Unsupported channel: ${req.channel}` };
}

async function executeRun(req: ControlRequest, portalOwner: UserId): Promise<Record<string, unknown>> {
  if (!req.agentId) {
    return { success: false, error: "agentId is required" };
  }

  // Handle deferred one-shot execution
  if (req.scheduledFor) {
    const runAt = new Date(req.scheduledFor);
    if (isNaN(runAt.getTime())) {
      return { success: false, error: "Invalid scheduledFor timestamp" };
    }
    const job = await scheduleOneShot(req.agentId, runAt, {
      profile: req.profile,
      params: { prompt: req.prompt, ...req.context },
      description: req.description,
      notificationChannel: req.notificationChannel,
      notificationRecipient: req.notificationRecipient,
      trustTier: req.trustTier,
    });
    return { success: true, scheduled: true, jobId: job.id, nextRun: new Date(job.nextRun).toISOString() };
  }

  const traceId = createTraceId();
  await createTrace(traceId, req.agentId, {
    trigger: "control",
    profile: req.profile,
  });

  const launcher = getLauncher();
  const result = await launcher.launch({
    agentId: req.agentId,
    profile: req.profile,
    // An immediate run through the control API is owner-initiated from the
    // portal (the endpoint is network-gated to localhost/tailnet), so it runs
    // as the selected household owner.
    identity: toRunIdentity(portalIdentity(portalOwner)),
    prompt: req.prompt ?? "Run.",
    context: {
      currentTime: currentTimePST(),
      ...req.context,
    },
    additionalEnv: { NORTHSTAR_TRACE_ID: traceId },
  });

  await completeTrace(traceId, {
    success: result.success,
    error: result.error,
  });

  return {
    success: result.success,
    rawText: result.rawText,
    error: result.error,
  };
}

async function executeSchedule(req: ControlRequest): Promise<Record<string, unknown>> {
  // Delete a job
  if (req.jobId && !req.cron && !req.agentId) {
    await deleteJob(req.jobId);
    return { success: true, deleted: req.jobId };
  }

  // Create a recurring job
  if (!req.agentId) {
    return { success: false, error: "agentId is required" };
  }
  if (!req.cron) {
    return { success: false, error: "cron expression is required for schedule action" };
  }

  const jobId = req.jobId ?? `recurring:${req.agentId}:${req.profile ?? "default"}:${req.cron!.replace(/\s+/g, "_")}`;
  try {
    const job = await scheduleRecurring(jobId, req.agentId, req.cron, {
      profile: req.profile,
      params: { prompt: req.prompt, ...req.context },
      description: req.description,
      notificationChannel: req.notificationChannel,
      notificationRecipient: req.notificationRecipient,
      trustTier: req.trustTier,
    });
    return {
      success: true,
      jobId: job.id,
      cron: job.cron,
      nextRun: new Date(job.nextRun).toISOString(),
      description: job.description,
    };
  } catch (err) {
    return { success: false, error: `Invalid cron expression: ${err instanceof Error ? err.message : err}` };
  }
}

async function executeUpdateSchedule(req: ControlRequest): Promise<Record<string, unknown>> {
  if (!req.jobId) {
    return { success: false, error: "jobId is required for update_schedule" };
  }

  const existing = await getJob(req.jobId);
  if (!existing) {
    return { success: false, error: `Job not found: ${req.jobId}` };
  }

  // Merge provided fields into the existing job
  if (req.cron !== undefined) {
    const { CronExpressionParser } = await import("cron-parser");
    try {
      const interval = CronExpressionParser.parse(req.cron, { currentDate: new Date() });
      existing.cron = req.cron;
      existing.nextRun = interval.next().getTime();
    } catch (err) {
      return { success: false, error: `Invalid cron expression: ${err instanceof Error ? err.message : err}` };
    }
  }
  if (req.prompt !== undefined) {
    existing.params = { ...existing.params, prompt: req.prompt };
  }
  if (req.description !== undefined) {
    existing.description = req.description;
  }
  if (req.profile !== undefined) {
    existing.profile = req.profile;
  }
  if (req.notificationChannel !== undefined) {
    existing.notificationChannel = req.notificationChannel;
  }
  if (req.notificationRecipient !== undefined) {
    existing.notificationRecipient = req.notificationRecipient;
  }
  if (req.trustTier !== undefined) {
    existing.trustTier = req.trustTier;
  }

  await upsertJob(existing);

  return {
    success: true,
    jobId: existing.id,
    cron: existing.cron,
    nextRun: new Date(existing.nextRun).toISOString(),
    description: existing.description,
  };
}

// --- Route handler ---

export async function POST(request: NextRequest) {
  const req = (await request.json()) as ControlRequest;

  if (!req.action) {
    return NextResponse.json(
      { success: false, error: "action is required (notify | run | schedule)" },
      { status: 400 }
    );
  }

  const portalOwner = parsePortalOwner(request.cookies.get("portal_owner")?.value);

  try {
    const result = await executeAction(req, portalOwner);
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Control] Action failed:", error);
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}

export async function GET() {
  try {
    const jobs = await listJobs();
    return NextResponse.json({ jobs });
  } catch (err) {
    return NextResponse.json({ jobs: [], error: String(err) });
  }
}
