#!/usr/bin/env node

/**
 * Email-Household MCP Server
 *
 * A minimal-privilege escalation tool: email the household members (Danny and
 * Betty) — and ONLY them. Like `reply`, the destination is NOT chosen by the
 * agent: the recipient is resolved server-side from the household address env
 * vars (DANNY_EMAIL / BETTY_EMAIL), so the agent picks "danny", "betty", or
 * "both" but can never redirect this to an arbitrary address.
 *
 * That's what makes it safe to grant at GUEST trust. When an unverified/guest
 * sender writes in (e.g. replying to mail Buri sent), Buri can loop the
 * household in or ask them to act — without gaining the ability to send mail to
 * anyone else. Contrast with `send_email` (the `email` capability), which takes
 * an agent-supplied recipient and therefore stays household-trust only.
 *
 * Delivery is proxied through the Northstar control API (`notify` action, email
 * channel), the same path as `send_email`, so the outbound thread is recorded
 * and a household reply comes back with full context.
 *
 * Env:
 *   NORTHSTAR_URL — Base URL for the control API (default: http://localhost:3000)
 *   DANNY_EMAIL   — Danny's address(es), comma-separated (first is primary)
 *   BETTY_EMAIL   — Betty's address(es), comma-separated (first is primary)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const NORTHSTAR_URL = process.env.NORTHSTAR_URL || "http://localhost:3000";

/** Primary address for a household member, or null if unconfigured. */
function primaryAddress(envValue) {
  const first = (envValue ?? "").split(",").map((e) => e.trim()).filter(Boolean)[0];
  return first ?? null;
}

/** Resolve the "to" selector into [{ member, address }], skipping unconfigured members. */
function resolveRecipients(to) {
  const members =
    to === "danny" ? ["danny"] : to === "betty" ? ["betty"] : ["danny", "betty"];
  const envByMember = { danny: process.env.DANNY_EMAIL, betty: process.env.BETTY_EMAIL };
  const resolved = [];
  const missing = [];
  for (const member of members) {
    const address = primaryAddress(envByMember[member]);
    if (address) resolved.push({ member, address });
    else missing.push(member);
  }
  return { resolved, missing };
}

const server = new Server(
  { name: "email-household", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "email_household",
    description:
      "Email the household — Danny and/or Betty — to loop them in or ask them to act. " +
      "Use this when you need to reach the people you serve: relaying something a sender told you, " +
      "escalating a decision only they can make, or flagging something that needs their attention. " +
      "You choose WHO among the household (danny, betty, or both) but NOT the address — it is always " +
      "one of the household members, never anyone else. This starts a new email thread; when they reply, " +
      "it comes back to you with the full history attached. " +
      "This is separate from replying to whoever wrote in (use `reply` for that).",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          enum: ["danny", "betty", "both"],
          description: "Which household member(s) to email. Defaults to both.",
        },
        subject: { type: "string", description: "Email subject line." },
        message: {
          type: "string",
          description:
            "The email body. Include the context they need — who this concerns and what you need from them.",
        },
      },
      required: ["subject", "message"],
    },
  },
];

async function handleEmailHousehold(args) {
  const { to = "both", subject, message } = args;

  if (!subject || !message) {
    return {
      content: [{ type: "text", text: "email_household requires `subject` and `message`." }],
      isError: true,
    };
  }

  const { resolved, missing } = resolveRecipients(to);
  if (resolved.length === 0) {
    return {
      content: [
        {
          type: "text",
          text: `No household address is configured for: ${missing.join(", ") || to}. Cannot send.`,
        },
      ],
      isError: true,
    };
  }

  // Forward source-task facts (if this run came from a task) so the created
  // thread is linked for reply continuity — same as send_email.
  let threadContext;
  const rawCtx = process.env.NORTHSTAR_THREAD_CONTEXT;
  if (rawCtx) {
    try { threadContext = JSON.parse(rawCtx); } catch { /* ignore malformed */ }
  }

  const sent = [];
  const failed = [];
  for (const { member, address } of resolved) {
    try {
      const res = await fetch(`${NORTHSTAR_URL}/api/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "notify",
          channel: "email",
          to: address,
          subject,
          message,
          ...(threadContext && { threadContext }),
        }),
      });
      const result = await res.json();
      if (result.success) sent.push(member);
      else failed.push(`${member} (${result.error ?? "unknown error"})`);
    } catch (err) {
      failed.push(`${member} (${err.message})`);
    }
  }

  const parts = [];
  if (sent.length) parts.push(`Sent to ${sent.join(" and ")}.`);
  if (missing.length) parts.push(`No address configured for ${missing.join(", ")}.`);
  if (failed.length) parts.push(`Failed for ${failed.join("; ")}.`);

  return {
    content: [{ type: "text", text: parts.join(" ") }],
    isError: sent.length === 0,
  };
}

const handlers = {
  email_household: handleEmailHousehold,
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
