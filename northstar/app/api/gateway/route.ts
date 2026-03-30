/**
 * Gateway API
 *
 * Single entry point for triggering agent executions and sending notifications.
 *
 * Actions:
 *   notify  — Send a message to Slack (immediately or scheduled)
 *   run     — Execute an agent (immediately or scheduled)
 *   schedule — Create a recurring job
 *
 * Supports `scheduledFor` for one-shot deferred execution,
 * or `cron` for recurring jobs.
 *
 * Examples:
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"notify","channel":"slack","message":"done"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri","profile":"xmanager"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri","scheduledFor":"2026-03-28T09:00:00Z"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"schedule","agentId":"buri","profile":"xmanager","cron":"0,30 * * * *","description":"Feed scan every 30 min"}'
 */

import { NextRequest, NextResponse } from "next/server";
import { sendMessage, replyInThread, isSlackConfigured } from "@/lib/slack";
import { getLauncher } from "@/lib/harness";
import { getSetting } from "@/lib/db";
import { getOrchestrator, type OrchestratorParams } from "@/lib/orchestrators";
import { scheduleOneShot, scheduleRecurring, listJobs, deleteJob } from "@/lib/redis";

interface GatewayRequest {
  action: "notify" | "run" | "schedule";

  // --- notify fields ---
  channel?: "slack";
  message?: string;
  from?: string;
  slackChannel?: string;
  threadTs?: string;

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
    });
    return { success: true, scheduled: true, jobId: job.id, nextRun: new Date(job.nextRun).toISOString() };
  }

  // Check for agent-specific orchestrator
  const orchestrator = getOrchestrator(req.agentId, req.profile);
  if (orchestrator) {
    const params: OrchestratorParams = {
      prompt: req.prompt,
      conversationId: req.conversationId,
      slackChannel: req.slackChannel,
      context: req.context,
    };
    return orchestrator(params);
  }

  // No orchestrator — launch directly
  const launcher = getLauncher();
  const result = await launcher.launch({
    agentId: req.agentId,
    profile: req.profile,
    prompt: req.prompt ?? "Run.",
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
      ...req.context,
    },
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

  const jobId = req.jobId ?? `recurring:${req.agentId}:${req.profile ?? "default"}`;
  try {
    const job = await scheduleRecurring(jobId, req.agentId, req.cron, {
      profile: req.profile,
      params: { prompt: req.prompt, ...req.context },
      description: req.description,
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
