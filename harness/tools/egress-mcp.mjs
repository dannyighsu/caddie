#!/usr/bin/env node

/**
 * Egress MCP Server
 *
 * MCP server for outbound messaging — Slack, email, etc.
 * Proxies through the Caddie control API (/api/control).
 *
 * Env:
 *   PORTAL_URL — Base URL for the portal control API (default: http://localhost:3000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, isAbsolute } from "node:path";

const PORTAL_URL = process.env.PORTAL_URL || "http://localhost:3000";
// The agent's working directory, injected by the launcher. File attachments
// must resolve inside it, so the tool can't be used to post arbitrary files
// off the host.
const WORKSPACE = process.env.CADDIE_WORKSPACE || process.cwd();
// Upload bytes travel as base64 JSON through the control API; keep it sane.
const MAX_FILE_BYTES = 25 * 1024 * 1024;

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
      "Messages support Slack mrkdwn formatting (*bold*, _italic_, `code`, >quotes, <url|text> links). " +
      "For a rich layout (header, fields, a divider, context lines, a monospace table in a section), pass `blocks`: an array of Block Kit blocks. " +
      "`message` is still required and becomes the notification fallback text Slack shows in push notifications and anywhere blocks can't render, so write it as a readable plain-text version of the same content. " +
      "Blocks can't be combined with filePath. " +
      "To ask for structured input, send a form, which is a legitimate use even in the conversation you're handling (pass its threadTs): `input` blocks for the fields, then an `actions` block with a submit button. Inputs in `input` blocks send nothing until the button is clicked, while anything interactive in an `actions` block submits the moment it's used, so a select there is only for a single-question form. " +
      "Give blocks and elements stable block_id and action_id values. A submit closes the form, so it takes one answer, and the answer comes back to you later as a new message in that thread starting \"[Slack form response]\", from whoever clicked. Link buttons aren't responses. " +
      "To share a file (a PDF report, a CSV, an image), pass filePath: the file is uploaded into the channel and `message` becomes the text that introduces it. " +
      "Readers can't reach your workspace, so attach the file rather than linking to its path. " +
      "Sharing a file in a public channel the bot isn't in makes it join that channel first.",
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
        filePath: {
          type: "string",
          description:
            "Path of a file to attach, relative to your working directory (e.g. runs/2026-09/29_tuesday/artifacts/report.pdf). Must be inside your working directory; max 25 MB.",
        },
        fileTitle: {
          type: "string",
          description: "Display title for the attached file. Defaults to its filename.",
        },
        blocks: {
          type: "array",
          items: { type: "object" },
          description:
            "Block Kit blocks for a rich layout, e.g. [{\"type\":\"header\",\"text\":{\"type\":\"plain_text\",\"text\":\"Usage\"}}]. Max 50; each entry needs a \"type\". A JSON string of the array is also accepted. Omit for a plain mrkdwn post.",
        },
      },
      required: ["message"],
    },
  },
  {
    name: "list_slack_channels",
    description:
      "List the Slack channels in the workspace — use this to resolve a channel by NAME into the channel ID that post_to_slack takes, or to check whether posting somewhere will work at all. " +
      "Each result has: id, name, isPrivate, isMember, isArchived, canPost, and (when Slack reports them) numMembers, topic, purpose. " +
      "canPost is the one that decides success — NOT isMember: the bot can post to public channels it hasn't joined, so isMember:false with canPost:true is normal. Postable channels are listed first. " +
      "Pass nameFilter to search by substring instead of pulling the whole workspace.",
    inputSchema: {
      type: "object",
      properties: {
        nameFilter: {
          type: "string",
          description:
            "Case-insensitive substring to match against channel names, e.g. 'eng' matches 'engineering'. Omit to list everything.",
        },
        types: {
          type: "string",
          description:
            "Slack conversation types to include, comma-separated: public_channel, private_channel, mpim, im. Defaults to 'public_channel,private_channel'.",
        },
        includeArchived: {
          type: "boolean",
          description:
            "Include archived channels. Defaults to false — archived channels cannot be posted to.",
        },
        limit: {
          type: "number",
          description:
            "Maximum channels to return after filtering. Defaults to 200. Narrow with nameFilter rather than raising this.",
        },
      },
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
          description: "Optional attribution label (e.g. your name).",
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
      "Create a recurring scheduled job on a cron schedule. " +
      "USE THIS for any recurring task request like 'every weekday at 9am', 'every hour', etc. " +
      "DO NOT use Claude Code's built-in CronCreate — that is blocked. " +
      "Two kinds, chosen with `type`: an agent run (default — each tick is a full agent turn, driven by `prompt`), " +
      "or a shell command (`type: \"command\"` — each tick runs `command`, and only a tick that PRINTS something " +
      "costs anything further). Use `type: \"command\"` for frequent polling: a 5-minute poller written as an agent " +
      "run is ~130 agent turns a day, while as a command job it is 130 cheap subprocesses and an agent turn only when " +
      "there is actually something to handle. " +
      "Notifications/results are delivered to the configured notificationChannel (defaults to slack).",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["agent", "command"],
          description:
            "What each tick does. 'agent' (default) launches a full agent run with `prompt`. 'command' runs `command` in a shell and only escalates if it wrote to stdout — see `onOutput`.",
        },
        command: {
          type: "string",
          description:
            "For type 'command': the shell command line to run each tick. A full command line, so pipes, && and redirection work (e.g. 'git pull -q && python3 scripts/poll.py'). Required for a command job.",
        },
        cwd: {
          type: "string",
          description:
            "For type 'command': workspace-relative working directory (e.g. 'mounts/library'). Defaults to the workspace root. Must stay inside the workspace. Note that repo mounts expire and are swept, so a command job pointed at one will start failing once it is gone — prefer a directory that persists.",
        },
        onOutput: {
          type: "string",
          enum: ["run", "notify", "ignore"],
          description:
            "For type 'command': what a tick that printed to stdout does. 'run' (default) launches an agent run with the output appended to `prompt`; 'notify' sends the output to the notification channel; 'ignore' only logs it. Stdout that is empty ALWAYS does nothing. A non-zero exit is reported as a job failure either way.",
        },
        commandTimeoutMs: {
          type: "number",
          description:
            "For type 'command': wall-clock limit per tick in milliseconds. Defaults to 60000, maximum 600000. The command (and anything it spawned) is killed if it overruns, and the tick is reported as a failure.",
        },
        commandEnv: {
          type: "array",
          items: { type: "string" },
          description:
            "For type 'command': NAMES of environment variables to forward to the command (e.g. ['GRANOLA_API_KEY']). Pass names, never values. Nothing beyond PATH/HOME/LANG/TZ is forwarded unless named here.",
        },
        profile: {
          type: "string",
          description:
            "Named run variant from agent.json's profiles — currently only 'extended' (a higher turn limit, for long research jobs). NOT a skill name: to run a skill, put its invocation in `prompt`. Omit for the default configuration.",
        },
        cron: {
          type: "string",
          description:
            "Cron expression: 'minute hour day-of-month month day-of-week'. Examples: '0 9 * * 1-5' (weekdays 9am), '0,30 * * * *' (every 30 min), '0 9 * * 2' (Tuesdays 9am).",
        },
        prompt: {
          type: "string",
          description:
            "The prompt/instruction the agent receives each time the job fires. Required for type 'agent', and for type 'command' with onOutput 'run' (where the command's output is appended to it).",
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
          description: "Optional channel-specific recipient override. Worth setting explicitly when the job's failures matter: without it, Slack delivery depends on a default channel being configured, and failure alerts fall back to the owner's email.",
        },
      },
      required: ["cron"],
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
        profile: {
          type: "string",
          description:
            "Named run variant from agent.json's profiles — currently only 'extended'. NOT a skill name. Omit for the default configuration.",
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
          description: "Optional channel-specific recipient override. Worth setting explicitly when the job's failures matter: without it, Slack delivery depends on a default channel being configured, and failure alerts fall back to the owner's email.",
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
        command: {
          type: "string",
          description: "Command-job only: new shell command line. Omit to keep the current one.",
        },
        cwd: {
          type: "string",
          description: "Command-job only: new workspace-relative working directory.",
        },
        onOutput: {
          type: "string",
          enum: ["run", "notify", "ignore"],
          description: "Command-job only: new handling for a tick that printed output.",
        },
        commandTimeoutMs: {
          type: "number",
          description: "Command-job only: new per-tick wall-clock limit in milliseconds.",
        },
        commandEnv: {
          type: "array",
          items: { type: "string" },
          description: "Command-job only: new list of environment variable NAMES to forward. Replaces the existing list.",
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

/**
 * Read a workspace file for upload. Throws with a message meant for the model
 * when the path escapes the workspace (symlinks included), is missing, or is
 * too large.
 */
async function readWorkspaceFile(filePath) {
  const root = await realpath(WORKSPACE);
  let full;
  try {
    full = await realpath(resolve(root, filePath));
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  const rel = relative(root, full);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`File must be inside your working directory: ${filePath}`);
  }
  const info = await stat(full);
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (info.size > MAX_FILE_BYTES) {
    throw new Error(`File is ${info.size} bytes; the limit is ${MAX_FILE_BYTES}.`);
  }
  return { filename: basename(full), data: await readFile(full) };
}

async function handlePostToSlack(args) {
  const { message, from, channel, threadTs, filePath, fileTitle, blocks } = args;

  let file;
  if (filePath) {
    const { filename, data } = await readWorkspaceFile(filePath);
    file = {
      filename,
      contentBase64: data.toString("base64"),
      ...(fileTitle && { title: fileTitle }),
    };
  }

  // If this run was created by one of the agent's own tasks, its source-task
  // facts arrive via CADDIE_THREAD_CONTEXT (inherited from the run env, set
  // only for scheduled/triggered runs). Forward them so a reply in the posted
  // Slack thread can be traced back to the task (mirrors the send_email path).
  let threadContext;
  const rawCtx = process.env.CADDIE_THREAD_CONTEXT;
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
    ...(file && { file }),
    ...(blocks !== undefined && { blocks }),
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
    content: [
      {
        type: "text",
        text: file
          ? `Posted to Slack with ${file.filename} attached.`
          : blocks
            ? "Block Kit message posted to Slack."
            : "Message posted to Slack.",
      },
    ],
  };
}

async function handleListSlackChannels(args) {
  const { nameFilter, types, includeArchived, limit } = args;

  const res = await fetch(`${PORTAL_URL}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "list_slack_channels",
      ...(nameFilter && { nameFilter }),
      ...(types && { types }),
      ...(includeArchived !== undefined && { includeArchived }),
      ...(limit !== undefined && { limit }),
    }),
  });

  const result = await res.json();

  if (!result.success) {
    return {
      content: [{ type: "text", text: `Failed to list channels: ${result.error}` }],
      isError: true,
    };
  }

  const channels = result.channels ?? [];
  if (channels.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: nameFilter
            ? `No channels matched "${nameFilter}". The bot only sees public channels plus private ones it belongs to.`
            : "No channels visible to the bot.",
        },
      ],
    };
  }

  // Note truncation explicitly: without it, "not in the list" reads as
  // "doesn't exist" when it really means "we stopped paging".
  const note = result.truncated
    ? "\n\n(Results truncated — narrow with nameFilter or raise limit.)"
    : "";

  return {
    content: [
      {
        type: "text",
        text: `${channels.length} channel(s):\n${JSON.stringify(channels, null, 2)}${note}`,
      },
    ],
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
    cron: args.cron,
    prompt: args.prompt,
    ...(args.type && { type: args.type }),
    ...(args.command && { command: args.command }),
    ...(args.cwd && { cwd: args.cwd }),
    ...(args.onOutput && { onOutput: args.onOutput }),
    ...(args.commandTimeoutMs && { commandTimeoutMs: args.commandTimeoutMs }),
    ...(args.commandEnv && { commandEnv: args.commandEnv }),
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
    ...(args.command && { command: args.command }),
    ...(args.cwd && { cwd: args.cwd }),
    ...(args.onOutput && { onOutput: args.onOutput }),
    ...(args.commandTimeoutMs && { commandTimeoutMs: args.commandTimeoutMs }),
    ...(args.commandEnv && { commandEnv: args.commandEnv }),
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
  list_slack_channels: handleListSlackChannels,
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
