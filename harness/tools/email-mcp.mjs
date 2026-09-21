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
      "Send an outbound email from your Gmail inbox. " +
      "Use this for mail you initiate — reaching out to someone, sending a heads-up or notification — and for FOLLOW-UPS on a thread you started (pass the `threadId` this tool returned). " +
      "DO NOT use this to answer an email someone just sent you: the harness already delivers your reply into the current thread automatically, and using this would start a new thread. " +
      "Any reply the recipient sends comes back to you with the full thread history attached, so you don't need to restate context you've already sent. " +
      "`to`, `cc` and `bcc` each accept several addresses, so \"send this and copy me\" puts everyone on one thread. " +
      "Pass `html` instead of `message` when the mail benefits from real formatting. " +
      "Returns the sent message's `messageId` and `threadId` — keep the `threadId` if you may need to follow up.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          description:
            "Recipient email address, or several — either an array of addresses or one " +
            "comma-separated string. Everyone listed here can see each other and stays on " +
            "the same thread, so replies reach all of them.",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        cc: {
          description:
            "Optional Cc recipients (array or comma-separated string). Use this to loop " +
            "someone in — a teammate who should see the exchange — rather than sending them " +
            "a separate copy, which would split the conversation across threads.",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        bcc: {
          description:
            "Optional Bcc recipients (array or comma-separated string). They receive the " +
            "mail but are not visible to the other recipients, and are not on the thread " +
            "for replies.",
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
        threadId: {
          type: "string",
          description:
            "Optional. Continue an existing thread you started, instead of opening a new " +
            "one: pass the `threadId` a previous send returned (or one from " +
            "`search_emails`/`get_email`). The follow-up then threads with the earlier " +
            "messages in the recipient's mail client. Omit it for genuinely new mail. " +
            "With a threadId, `subject` is optional — the thread's own subject is reused.",
        },
        subject: {
          type: "string",
          description:
            "Email subject line. Optional when `threadId` is given (the thread's subject is reused).",
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
      required: ["to"],
    },
  },
];

/**
 * Normalize a recipient field to the comma-separated header string the control
 * API expects. Accepts an array or a single string so the model can pass either
 * without the call failing on a shape mismatch; blank entries are dropped.
 */
function addressList(value) {
  const parts = Array.isArray(value) ? value : String(value ?? "").split(",");
  return parts.map((a) => String(a).trim()).filter(Boolean).join(", ");
}

async function handleSendEmail(args) {
  const { subject, message, html, threadId } = args;
  const to = addressList(args.to);
  const cc = addressList(args.cc);
  const bcc = addressList(args.bcc);

  if (!to) {
    return {
      content: [{ type: "text", text: "send_email requires at least one `to` recipient." }],
      isError: true,
    };
  }
  // A subject is required for new mail; a follow-up inherits the thread's.
  if (!subject && !threadId) {
    return {
      content: [
        {
          type: "text",
          text: "send_email requires a `subject` for new mail (omit it only when continuing a thread via `threadId`).",
        },
      ],
      isError: true,
    };
  }
  if (!message && !html) {
    return {
      content: [{ type: "text", text: "send_email requires a body — either `message` or `html`." }],
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
      ...(subject && { subject }),
      ...(cc && { cc }),
      ...(bcc && { bcc }),
      ...(threadId && { threadId }),
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

  // Hand back the ids: `threadId` is what a later turn passes to `send_email`
  // to follow up on this same thread rather than opening a second one.
  const recipients = to + (cc ? ` (cc ${cc})` : "") + (bcc ? ` (bcc ${bcc})` : "");
  const ids = [
    result.threadId ? `threadId: ${result.threadId}` : null,
    result.messageId ? `messageId: ${result.messageId}` : null,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    content: [
      {
        type: "text",
        text:
          `Email sent to ${recipients}.` +
          (ids ? `\n${ids}\nTo follow up in this same thread, call send_email again with threadId.` : ""),
      },
    ],
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
