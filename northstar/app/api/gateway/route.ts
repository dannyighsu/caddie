/**
 * Gateway API
 *
 * Single entry point for triggering agent executions and sending notifications.
 * Designed to be called from Claude Code skills, scripts, cron jobs, Slack,
 * the control plane UI, or other agents.
 *
 * Actions:
 *   notify  — Send a message to Slack (immediately or scheduled)
 *   run     — Execute an agent (immediately or scheduled)
 *
 * All actions support an optional `scheduledFor` ISO timestamp to defer execution.
 *
 * Examples:
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"notify","channel":"slack","message":"done"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"checkin"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"xmanager"}'
 *   curl -X POST localhost:3000/api/gateway -d '{"action":"notify","channel":"slack","message":"reminder","scheduledFor":"2026-03-27T09:00:00Z"}'
 */

import { NextRequest, NextResponse } from "next/server";
import { sendMessage, replyInThread, isSlackConfigured } from "@/lib/slack";
import { getLauncher } from "@/lib/harness";
import { getSetting } from "@/lib/db";
import { getOrchestrator, type OrchestratorParams } from "@/lib/orchestrators";
import { v4 as uuid } from "uuid";

interface GatewayRequest {
  action: "notify" | "run";

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
  scheduledFor?: string;
}

// --- Scheduled tasks (in-memory, resets on restart) ---

interface ScheduledTask {
  id: string;
  executeAt: number;
  request: GatewayRequest;
}

const scheduledTasks: ScheduledTask[] = [];
let timerRunning = false;

function startScheduler() {
  if (timerRunning) return;
  timerRunning = true;

  setInterval(async () => {
    const now = Date.now();
    const due = scheduledTasks.filter((t) => t.executeAt <= now);
    for (const task of due) {
      const idx = scheduledTasks.indexOf(task);
      if (idx !== -1) scheduledTasks.splice(idx, 1);
      try {
        console.log(`[Gateway] Executing scheduled task: ${task.request.action}`);
        await executeAction(task.request);
      } catch (err) {
        console.error(`[Gateway] Scheduled task failed:`, err);
      }
    }
  }, 5000);
}

// --- Action execution ---

async function executeAction(req: GatewayRequest): Promise<Record<string, unknown>> {
  switch (req.action) {
    case "notify":
      return executeNotify(req);
    case "run":
      return executeRun(req);
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

// --- Route handler ---

export async function POST(request: NextRequest) {
  const req = (await request.json()) as GatewayRequest;

  if (!req.action) {
    return NextResponse.json(
      { success: false, error: "action is required (notify | run)" },
      { status: 400 }
    );
  }

  // Handle scheduled execution
  if (req.scheduledFor) {
    const executeAt = new Date(req.scheduledFor).getTime();
    if (isNaN(executeAt)) {
      return NextResponse.json(
        { success: false, error: "Invalid scheduledFor timestamp" },
        { status: 400 }
      );
    }

    const id = uuid();
    scheduledTasks.push({ id, executeAt, request: req });
    startScheduler();

    console.log(
      `[Gateway] Scheduled ${req.action} for ${req.scheduledFor} (in ${Math.round((executeAt - Date.now()) / 1000)}s)`
    );

    return NextResponse.json({
      success: true,
      scheduled: true,
      taskId: id,
      executeAt: new Date(executeAt).toISOString(),
    });
  }

  // Execute immediately
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
  return NextResponse.json({
    pending: scheduledTasks.map((t) => ({
      id: t.id,
      action: t.request.action,
      executeAt: new Date(t.executeAt).toISOString(),
    })),
  });
}
