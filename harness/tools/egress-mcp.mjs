#!/usr/bin/env node

/**
 * Egress MCP Server
 *
 * MCP server for outbound messaging — Slack, email, etc.
 * Proxies through the Northstar control API (/api/control).
 *
 * Env:
 *   PORTAL_URL — Base URL for the portal control API (default: http://localhost:3000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORTAL_URL = process.env.PORTAL_URL || "http://localhost:3000";
// The agent this server is mounted for — injected by the launcher, so schedule
// tools default to "run me" instead of making the model name itself.
const AGENT_ID = process.env.NORTHSTAR_AGENT_ID || "buri";

const server = new Server(
  { name: "egress", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// --- Tool definitions ---

const tools = [
  {
    name: "post_to_slack",
    description:
      "Post an EXTRA message to Slack — for intermediate updates, side-channel notifications, or surfacing something to a Slack channel that is NOT the user's reply. " +
      "DO NOT use this for your final response or summary: the system automatically delivers your final output to the originating channel (which may not even be Slack). " +
      "Calling this with your final summary will cause duplicate messages. " +
      "Legitimate uses: posting a long-running task progress update, alerting a different Slack channel about an event, or proactively raising an issue in Slack while the user is interacting via another channel. " +
      "Messages support Slack mrkdwn formatting (*bold*, _italic_, `code`, >quotes, <url|text> links).",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message to post.",
        },
        from: {
          type: "string",
          description:
            "Attribution label. Message will be formatted as **[from]** message.",
        },
        channel: {
          type: "string",
          description:
            "Slack channel ID to post to. Omit to use the default channel.",
        },
        threadTs: {
          type: "string",
          description:
            "Thread timestamp to reply in. Omit to post as a new message.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "schedule_reminder",
    description:
      "Schedule a one-shot notification (reminder) to be sent at a specific time. " +
      "USE THIS for any reminder request like 'remind me at 3pm', 'send me a notification tomorrow morning', etc. " +
      "DO NOT use Claude Code's built-in CronCreate or any other scheduling tool — those are blocked. " +
      "By default the reminder is delivered on the same channel the user contacted you on (use the originChannel context).",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The reminder message to send when the time arrives.",
        },
        scheduledFor: {
          type: "string",
          description:
            "ISO 8601 timestamp for when the reminder should fire (e.g., '2026-04-09T20:00:00-07:00'). MUST be a fully qualified timestamp with timezone offset.",
        },
        from: {
          type: "string",
          description: "Optional attribution label (e.g., 'Buri').",
        },
        notificationChannel: {
          type: "string",
          enum: ["slack", "telegram", "email"],
          description:
            "Channel to deliver the reminder on. Default is 'slack'. Set to match the originChannel from your run context, or override only if the user explicitly asked for a different channel.",
        },
        notificationRecipient: {
          type: "string",
          description:
            "Optional channel-specific recipient override (Slack channel ID, Telegram chat ID, or email address). Omit to use the configured default for the channel.",
        },
        subject: {
          type: "string",
          description:
            "Email subject line (only used when notificationChannel is 'email').",
        },
      },
      required: ["message", "scheduledFor"],
    },
  },
  {
    name: "schedule_recurring",
    description:
      "Create a recurring scheduled job that runs an agent on a cron schedule. " +
      "USE THIS for any recurring task request like 'every weekday at 9am', 'every hour', etc. " +
      "DO NOT use Claude Code's built-in CronCreate — that is blocked. " +
      "Notifications/results are delivered to the configured notificationChannel (defaults to slack).",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description:
            "Agent to run. Omit to schedule yourself, which is almost always what you want.",
        },
        profile: {
          type: "string",
          description:
            "Named run variant from the agent's agent.json profiles — currently only 'extended' (a higher turn limit, for long research jobs). NOT a skill name: to run a skill, put its invocation in `prompt`. Omit for the default configuration.",
        },
        cron: {
          type: "string",
          description:
            "Cron expression: 'minute hour day-of-month month day-of-week'. Examples: '0 9 * * 1-5' (weekdays 9am), '0,30 * * * *' (every 30 min), '0 9 * * 2' (Tuesdays 9am).",
        },
        prompt: {
          type: "string",
          description: "The prompt/instruction the agent receives each time the job fires.",
        },
        description: {
          type: "string",
          description: "Human-readable description of what this schedule does.",
        },
        notificationChannel: {
          type: "string",
          enum: ["slack", "telegram", "email"],
          description: "Channel to deliver results/failure notifications on. Defaults to 'slack'.",
        },
        notificationRecipient: {
          type: "string",
          description: "Optional channel-specific recipient override.",
        },
      },
      required: ["cron", "prompt"],
    },
  },
  {
    name: "schedule_oneshot_run",
    description:
      "Schedule a one-time agent run at a specific future time (different from schedule_reminder — this RUNS the agent, not just sends a notification). " +
      "Use this only when the user wants the agent to actually do work at a future time, not just receive a reminder.",
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          description:
            "Agent to run. Omit to schedule yourself, which is almost always what you want.",
        },
        profile: {
          type: "string",
          description:
            "Named run variant from the agent's agent.json profiles — currently only 'extended'. NOT a skill name. Omit for the default configuration.",
        },
        prompt: {
          type: "string",
          description: "Prompt the agent receives when it runs.",
        },
        scheduledFor: {
          type: "string",
          description:
            "ISO 8601 timestamp with timezone offset (e.g., '2026-04-09T15:00:00-07:00').",
        },
        description: {
          type: "string",
          description: "Human-readable description.",
        },
        notificationChannel: {
          type: "string",
          enum: ["slack", "telegram", "email"],
          description: "Channel for results/failure notifications.",
        },
        notificationRecipient: {
          type: "string",
          description: "Optional channel-specific recipient override.",
        },
      },
      required: ["prompt", "scheduledFor"],
    },
  },
  {
    name: "list_schedules",
    description: "List all currently scheduled jobs. Returns the job ID, cron, next run time, and description for each.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "update_schedule",
    description:
      "Update an existing scheduled job. Only the fields you provide will be changed; everything else stays the same. " +
      "Use list_schedules first to find the job ID.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "The job ID to update.",
        },
        cron: {
          type: "string",
          description: "New cron expression. Omit to keep the current schedule.",
        },
        prompt: {
          type: "string",
          description: "New prompt/instruction. Omit to keep the current prompt.",
        },
        description: {
          type: "string",
          description: "New human-readable description.",
        },
        profile: {
          type: "string",
          description: "New profile/skill variant.",
        },
        notificationChannel: {
          type: "string",
          enum: ["slack", "telegram", "email"],
          description: "New notification channel.",
        },
        notificationRecipient: {
          type: "string",
          description: "New channel-specific recipient override.",
        },
      },
      required: ["jobId"],
    },
  },
  {
    name: "delete_schedule",
    description: "Delete a scheduled job by its job ID. Use list_schedules first to find the right ID.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: {
          type: "string",
          description: "The job ID to delete.",
        },
      },
      required: ["jobId"],
    },
  },
];

// --- Tool handlers ---

async function handlePostToSlack(args) {
  const { message, from, channel, threadTs } = args;

  // If this run was created by one of the agent's own tasks, its source-task
  // facts arrive via NORTHSTAR_THREAD_CONTEXT (inherited from the run env, set
  // only for scheduled/triggered runs). Forward them so a reply in the posted
  // Slack thread can be traced back to the task (mirrors the send_email path).
  let threadContext;
  const rawCtx = process.env.NORTHSTAR_THREAD_CONTEXT;
  if (rawCtx) {
    try { threadContext = JSON.parse(rawCtx); } catch { /* ignore malformed */ }
  }

  const body = {
    action: "notify",
    channel: "slack",
    message,
    ...(from && { from }),
    ...(channel && { slackChannel: channel }),
    ...(threadTs && { threadTs }),
    ...(threadContext && { threadContext }),
  };

  const res = await fetch(`${PORTAL_URL}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const result = await res.json();

  if (!result.success) {
    return {
      content: [{ type: "text", text: `Failed to post: ${result.error}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: "Message posted to Slack." }],
  };
}

// --- Schedule tool handlers ---

async function callControl(body) {
  const res = await fetch(`${PORTAL_URL}/api/control`, {
    method: body.action ? "POST" : "GET",
    headers: { "Content-Type": "application/json" },
    body: body.action ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function formatControlResponse(result, successMessage) {
  if (!result.success) {
    return {
      content: [{ type: "text", text: `Failed: ${result.error ?? "unknown error"}` }],
      isError: true,
    };
  }
  return {
    content: [
      {
        type: "text",
        text: `${successMessage}\n${JSON.stringify(result, null, 2)}`,
      },
    ],
  };
}

async function handleScheduleReminder(args) {
  const result = await callControl({
    action: "notify",
    message: args.message,
    scheduledFor: args.scheduledFor,
    ...(args.from && { from: args.from }),
    ...(args.notificationChannel && { notificationChannel: args.notificationChannel }),
    ...(args.notificationRecipient && { notificationRecipient: args.notificationRecipient }),
    ...(args.subject && { subject: args.subject }),
  });
  return formatControlResponse(result, "Reminder scheduled.");
}

async function handleScheduleRecurring(args) {
  const result = await callControl({
    action: "schedule",
    agentId: args.agentId ?? AGENT_ID,
    cron: args.cron,
    prompt: args.prompt,
    ...(args.profile && { profile: args.profile }),
    ...(args.description && { description: args.description }),
    ...(args.notificationChannel && { notificationChannel: args.notificationChannel }),
    ...(args.notificationRecipient && { notificationRecipient: args.notificationRecipient }),
  });
  return formatControlResponse(result, "Recurring schedule created.");
}

async function handleScheduleOneshotRun(args) {
  const result = await callControl({
    action: "run",
    agentId: args.agentId ?? AGENT_ID,
    prompt: args.prompt,
    scheduledFor: args.scheduledFor,
    ...(args.profile && { profile: args.profile }),
    ...(args.description && { description: args.description }),
    ...(args.notificationChannel && { notificationChannel: args.notificationChannel }),
    ...(args.notificationRecipient && { notificationRecipient: args.notificationRecipient }),
  });
  return formatControlResponse(result, "One-shot run scheduled.");
}

async function handleListSchedules() {
  const res = await fetch(`${PORTAL_URL}/api/control`, { method: "GET" });
  const result = await res.json();
  return {
    content: [
      {
        type: "text",
        text: `Scheduled jobs:\n${JSON.stringify(result, null, 2)}`,
      },
    ],
  };
}

async function handleUpdateSchedule(args) {
  const result = await callControl({
    action: "update_schedule",
    jobId: args.jobId,
    ...(args.cron && { cron: args.cron }),
    ...(args.prompt && { prompt: args.prompt }),
    ...(args.description && { description: args.description }),
    ...(args.profile && { profile: args.profile }),
    ...(args.notificationChannel && { notificationChannel: args.notificationChannel }),
    ...(args.notificationRecipient && { notificationRecipient: args.notificationRecipient }),
  });
  return formatControlResponse(result, `Updated job ${args.jobId}.`);
}

async function handleDeleteSchedule(args) {
  const result = await callControl({
    action: "schedule",
    jobId: args.jobId,
  });
  return formatControlResponse(result, `Deleted job ${args.jobId}.`);
}

const handlers = {
  post_to_slack: handlePostToSlack,
  schedule_reminder: handleScheduleReminder,
  schedule_recurring: handleScheduleRecurring,
  schedule_oneshot_run: handleScheduleOneshotRun,
  list_schedules: handleListSchedules,
  update_schedule: handleUpdateSchedule,
  delete_schedule: handleDeleteSchedule,
};

// --- MCP wiring ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];

  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    return await handler(args ?? {});
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
