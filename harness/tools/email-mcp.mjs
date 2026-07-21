#!/usr/bin/env node

/**
 * Email Egress MCP Server
 *
 * Outbound email for the agent, proxied through the Northstar control API
 * (`notify` action, `email` channel). Routing sends through the control API —
 * rather than calling AgentMail directly — means every send is recorded as a
 * local conversation keyed by its AgentMail thread id, so when the recipient
 * replies the shared messaging handler finds the thread and supplies prior
 * context.
 *
 * This is intentionally a SEPARATE, household-trust capability (see
 * capabilities/email.json) rather than a tool on the public `egress` server:
 * sending mail as the household must stay gated to authenticated senders.
 *
 * Env:
 *   NORTHSTAR_URL — Base URL for the Northstar control API (default: http://localhost:3000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const NORTHSTAR_URL = process.env.NORTHSTAR_URL || "http://localhost:3000";

const server = new Server(
  { name: "email", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "send_email",
    description:
      "Send an ad-hoc outbound email from your AgentMail inbox to a recipient. " +
      "Use this for NEW mail you initiate — reaching out to someone, sending a heads-up or notification. " +
      "DO NOT use this to answer an email someone just sent you: the harness already delivers your reply into the current thread automatically, and using this would start a new thread. " +
      "Any reply the recipient sends comes back to you with the full thread history attached, so you don't need to restate context you've already sent.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient email address.",
        },
        subject: {
          type: "string",
          description: "Email subject line.",
        },
        message: {
          type: "string",
          description: "The email body.",
        },
      },
      required: ["to", "subject", "message"],
    },
  },
  {
    name: "send_calendar_invite",
    description:
      "Send a calendar invite (.ics) from your AgentMail inbox to one or more people. " +
      "You are the organizer; each attendee receives a native calendar invitation (Yes/No/Maybe) they can add to their own calendar. " +
      "Use this INSTEAD of send_email whenever you want people to put an event on their calendar — you do not need your own calendar to do this. " +
      "RSVP responses (accept/decline) come back to your inbox as ordinary email, so watch your inbox to track who's coming.",
    inputSchema: {
      type: "object",
      properties: {
        attendees: {
          type: "array",
          items: { type: "string" },
          description: "Email addresses of the people to invite.",
        },
        summary: {
          type: "string",
          description: "Event title.",
        },
        startTime: {
          type: "string",
          description:
            "Start time in ISO 8601 with a UTC offset, e.g. 2026-07-25T10:00:00-07:00.",
        },
        endTime: {
          type: "string",
          description: "End time in ISO 8601 with a UTC offset.",
        },
        location: {
          type: "string",
          description: "Event location (optional).",
        },
        description: {
          type: "string",
          description: "Event description or agenda (optional).",
        },
      },
      required: ["attendees", "summary", "startTime", "endTime"],
    },
  },
];

async function handleSendEmail(args) {
  const { to, subject, message } = args;

  if (!to || !subject || !message) {
    return {
      content: [{ type: "text", text: "send_email requires `to`, `subject`, and `message`." }],
      isError: true,
    };
  }

  // If this run was launched by a task, the harness passes the source-task facts
  // via NORTHSTAR_THREAD_CONTEXT (inherited from the run env). Forward them so
  // the control API can attach them to the created thread for reply continuity.
  let threadContext;
  const rawCtx = process.env.NORTHSTAR_THREAD_CONTEXT;
  if (rawCtx) {
    try { threadContext = JSON.parse(rawCtx); } catch { /* ignore malformed */ }
  }

  const res = await fetch(`${NORTHSTAR_URL}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "notify",
      channel: "email",
      to,
      subject,
      message,
      ...(threadContext && { threadContext }),
    }),
  });

  const result = await res.json();

  if (!result.success) {
    return {
      content: [{ type: "text", text: `Failed to send email: ${result.error ?? "unknown error"}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `Email sent to ${to}.` }],
  };
}

async function handleSendCalendarInvite(args) {
  const { attendees, summary, startTime, endTime, location, description } = args;

  if (!Array.isArray(attendees) || attendees.length === 0 || !summary || !startTime || !endTime) {
    return {
      content: [
        {
          type: "text",
          text: "send_calendar_invite requires a non-empty `attendees` array, `summary`, `startTime`, and `endTime`.",
        },
      ],
      isError: true,
    };
  }

  // Forward source-task facts (if any) so the created thread carries context
  // for RSVP replies — same mechanism as send_email.
  let threadContext;
  const rawCtx = process.env.NORTHSTAR_THREAD_CONTEXT;
  if (rawCtx) {
    try { threadContext = JSON.parse(rawCtx); } catch { /* ignore malformed */ }
  }

  const res = await fetch(`${NORTHSTAR_URL}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "invite",
      attendees,
      summary,
      startTime,
      endTime,
      ...(location && { location }),
      // The control API carries the event description in `message`.
      ...(description && { message: description }),
      ...(threadContext && { threadContext }),
    }),
  });

  const result = await res.json();

  if (!result.success) {
    return {
      content: [{ type: "text", text: `Failed to send invite: ${result.error ?? "unknown error"}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: `Calendar invite "${summary}" sent to ${attendees.join(", ")}.` }],
  };
}

const handlers = {
  send_email: handleSendEmail,
  send_calendar_invite: handleSendCalendarInvite,
};

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
