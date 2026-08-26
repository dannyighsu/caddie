#!/usr/bin/env node

/**
 * Email Egress MCP Server
 *
 * Outbound email for the agent, proxied through the Northstar control API
 * (`notify` action, `email` channel). Routing sends through the control API —
 * rather than calling the Gmail API directly — means every send is recorded as a
 * local conversation keyed by its Gmail thread id, so when the recipient
 * replies the shared messaging handler finds the thread and supplies prior
 * context.
 *
 * This is intentionally a SEPARATE, team-trust capability (see
 * capabilities/email.json) rather than a tool on the public `egress` server:
 * sending mail as the team must stay gated to authenticated senders.
 *
 * Env:
 *   PORTAL_URL — Base URL for the portal control API (default: http://localhost:3000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORTAL_URL = process.env.PORTAL_URL || "http://localhost:3000";

const server = new Server(
  { name: "email", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "send_email",
    description:
      "Send an ad-hoc outbound email from your Gmail inbox to a recipient. " +
      "Use this for NEW mail you initiate — reaching out to someone, sending a heads-up or notification. " +
      "DO NOT use this to answer an email someone just sent you: the harness already delivers your reply into the current thread automatically, and using this would start a new thread. " +
      "Any reply the recipient sends comes back to you with the full thread history attached, so you don't need to restate context you've already sent. " +
      "Pass `html` instead of `message` when the mail benefits from real formatting.",
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
          description:
            "The email body as plain text. Omit this if you are supplying `html` — the plain-text " +
            "version is then derived from your HTML automatically.",
        },
        html: {
          type: "string",
          description:
            "Optional HTML body, for mail that benefits from real formatting — headings, lists, tables, links, emphasis. " +
            "Write a body fragment only (no <html>, <head>, or <body> wrapper) and put ALL styling in inline `style=` " +
            "attributes: mail clients strip <style> blocks and ignore external stylesheets, so a <style> rule simply " +
            "will not apply. No scripts, no remote images. Prefer plain `message` for short, conversational mail — " +
            "HTML is for when the structure genuinely helps the reader.",
        },
      },
      required: ["to", "subject"],
    },
  },
];

async function handleSendEmail(args) {
  const { to, subject, message, html } = args;

  if (!to || !subject || (!message && !html)) {
    return {
      content: [
        {
          type: "text",
          text: "send_email requires `to`, `subject`, and a body — either `message` or `html`.",
        },
      ],
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

  const res = await fetch(`${PORTAL_URL}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "notify",
      channel: "email",
      to,
      subject,
      ...(message && { message }),
      ...(html && { html }),
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

const handlers = {
  send_email: handleSendEmail,
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
