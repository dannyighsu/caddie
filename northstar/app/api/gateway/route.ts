/**
 * Gateway API
 *
 * Single entry point for triggering agent executions and sending notifications.
 *
 * Actions:
 *   notify  — Send a message to Slack or WhatsApp (immediately or scheduled)
 *   run     — Execute an agent (immediately or scheduled)
 *   schedule — Create a recurring job
 *
 * Supports `scheduledFor` for one-shot deferred execution,
 * or `cron` for recurring jobs.
 *
 * Examples:
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"notify","channel":"slack","message":"done"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"notify","channel":"whatsapp","to":"12125551234","message":"done"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri","profile":"xmanager"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri","scheduledFor":"2026-03-28T09:00:00Z"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"schedule","agentId":"buri","profile":"xmanager","cron":"0,30 * * * *","description":"Feed scan every 30 min"}'
 */

import { NextRequest, NextResponse } from "next/server";
import { sendMessage, replyInThread, isSlackConfigured } from "@/lib/slack";
import { sendBaileysMessage, isBaileysConnected } from "@/lib/baileys";
import { sendCloudAPIMessage, isCloudAPIConfigured } from "@/lib/whatsapp-api";
import { sendEmail, isEmailConfigured } from "@/lib/email";
import type { NotificationChannel } from "@/lib/notification-channels";
import { getLauncher } from "@/lib/harness";
import { getSetting } from "@/lib/db";
import { currentTimePST } from "@/lib/helpers";
import { scheduleOneShot, scheduleRecurring, scheduleNotification, listJobs, deleteJob } from "@/lib/redis";
import { createTraceId, createTrace, completeTrace } from "@/lib/tracing";

interface GatewayRequest {
  action: "notify" | "run" | "schedule";

  // --- notify fields ---
  channel?: NotificationChannel;
  message?: string;
  from?: string;
  slackChannel?: string;
  threadTs?: string;
  /** WhatsApp recipient phone number (international format, no +) or email address */
  to?: string;
  /** Email subject line */
  subject?: string;

  // --- run fields ---
  agentId?: string;
  profile?: string;
  prompt?: string;
  conversationId?: string;
  context?: Record<string, string>;

  // --- scheduling ---
  scheduledFor?: string;    // ISO timestamp for one-shot deferred execution
  cron?: string;            // Cron expression for recurring jobs
  jobId?: string;           // For deleting a job
  description?: string;
  /**
   * For scheduled run/notify jobs: the channel to deliver the result/notification on.
   * Defaults to "slack". Set to "whatsapp" or "email" to override.
   */
  notificationChannel?: NotificationChannel;
  /**
   * For scheduled jobs: channel-specific recipient override (Slack channel ID,
   * phone number, or email). If omitted, uses the channel's configured default.
   */
  notificationRecipient?: string;
}

// --- Action execution ---

async function executeAction(req: GatewayRequest): Promise<Record<string, unknown>> {
  switch (req.action) {
    case "notify":
      return executeNotify(req);
    case "run":
      return executeRun(req);
    case "schedule":
      return executeSchedule(req);
    default:
      return { success: false, error: `Unknown action: ${req.action}` };
  }
}

async function executeNotify(req: GatewayRequest): Promise<Record<string, unknown>> {
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
      (notificationChannel === "whatsapp" || notificationChannel === "email"
        ? req.to
        : undefined);

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

    if (req.threadTs) {
      await replyInThread(channelId, req.threadTs, formatted);
    } else {
      await sendMessage(channelId, formatted);
    }

    return { success: true, channel: "slack", channelId };
  }

  if (req.channel === "whatsapp") {
    const cloudConfigured = isCloudAPIConfigured();
    const baileysConnected = isBaileysConnected();

    if (!cloudConfigured && !baileysConnected) {
      return { success: false, error: "WhatsApp not available (neither Cloud API nor Baileys connected)" };
    }

    let recipient = req.to;
    if (!recipient) {
      const config = await getSetting<{ defaultRecipient?: string }>("whatsapp_config");
      recipient = config?.defaultRecipient;
    }
    if (!recipient) {
      return { success: false, error: "No WhatsApp recipient specified and no default configured" };
    }

    const formatted = req.from
      ? `*[${req.from}]* ${req.message}`
      : req.message;

    // Prefer Cloud API (dedicated bot number), fall back to Baileys
    if (cloudConfigured) {
      await sendCloudAPIMessage(recipient, formatted);
      return { success: true, channel: "whatsapp", via: "cloud-api", to: recipient };
    }

    const jid = recipient.includes("@") ? recipient : `${recipient}@s.whatsapp.net`;
    await sendBaileysMessage(jid, formatted);
    return { success: true, channel: "whatsapp", via: "baileys", to: recipient };
  }

  if (req.channel === "email") {
    if (!isEmailConfigured()) {
      return { success: false, error: "Email not configured (missing RESEND_API_KEY or EMAIL_FROM)" };
    }

    if (!req.to) {
      return { success: false, error: "Email recipient (to) is required" };
    }

    const subject = req.subject ?? "Notification";
    const formatted = req.from
      ? `[${req.from}] ${req.message}`
      : req.message;

    await sendEmail(req.to, subject, formatted);
    return { success: true, channel: "email", to: req.to };
  }

  return { success: false, error: `Unsupported channel: ${req.channel}` };
}

async function executeRun(req: GatewayRequest): Promise<Record<string, unknown>> {
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
    });
    return { success: true, scheduled: true, jobId: job.id, nextRun: new Date(job.nextRun).toISOString() };
  }

  const traceId = createTraceId();
  await createTrace(traceId, req.agentId, {
    trigger: "gateway",
    profile: req.profile,
  });

  const launcher = getLauncher();
  const result = await launcher.launch({
    agentId: req.agentId,
    profile: req.profile,
    prompt: req.prompt ?? "Run.",
    sessionId: req.conversationId,
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
    sessionId: result.sessionId,
    error: result.error,
  };
}

async function executeSchedule(req: GatewayRequest): Promise<Record<string, unknown>> {
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

// --- Route handler ---

export async function POST(request: NextRequest) {
  const req = (await request.json()) as GatewayRequest;

  if (!req.action) {
    return NextResponse.json(
      { success: false, error: "action is required (notify | run | schedule)" },
      { status: 400 }
    );
  }

  try {
    const result = await executeAction(req);
    const status = result.success ? 200 : 400;
    return NextResponse.json(result, { status });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Gateway] Action failed:", error);
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
