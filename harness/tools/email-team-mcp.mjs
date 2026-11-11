#!/usr/bin/env node

/**
 * Email-Team MCP Server
 *
 * A minimal-privilege escalation tool: email the team members — and ONLY them.
 * Like `reply`, the destination is NOT chosen by the agent: the portal resolves
 * recipients from the team roster, so the agent picks which member by id (or
 * "all") and can never redirect this to an arbitrary address. This process
 * never sees an address at all.
 *
 * That's what makes it safe to grant at GUEST trust. When an unverified sender
 * writes in (e.g. replying to mail the agent sent), the agent can loop the team
 * in or ask them to act — without gaining the ability to mail anyone else.
 * Contrast with `send_email` (the `email` capability), which takes an
 * agent-supplied recipient and therefore stays team-trust only.
 *
 * Delivery goes through the control API's `email_team` action, which sends
 * along the same path as `send_email`, so the outbound thread is recorded and
 * a team reply comes back with full context.
 *
 * The tool's `to` enum is generated at startup from CADDIE_TEAM, so each install
 * exposes its own people's ids.
 *
 * Env:
 *   PORTAL_URL        — Base URL for the portal control API (default: http://localhost:3000)
 *   CADDIE_TEAM       — JSON [{ id, name }] of the roster, set by the launcher
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORTAL_URL = process.env.PORTAL_URL || "http://localhost:3000";

/** The roster's ids and names, as the launcher passed them. No addresses. */
function roster() {
  try {
    const members = JSON.parse(process.env.CADDIE_TEAM ?? "[]");
    return Array.isArray(members) ? members : [];
  } catch {
    return [];
  }
}

const server = new Server(
  { name: "email-team", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const ROSTER = roster();
/** "all" plus one entry per configured member, so each install shows its own people. */
const TO_ENUM = [...ROSTER.map((m) => m.id), "all"];
const TEAM_DESCRIPTION =
  ROSTER.map((m) => `${m.name} (${m.id})`).join(", ") || "no members configured";

const tools = [
  {
    name: "email_team",
    description:
      `Email the team — ${TEAM_DESCRIPTION} — to loop them in or ask them to act. ` +
      "Use this when you need to reach the people you serve: relaying something a sender told you, " +
      "escalating a decision only they can make, or flagging something that needs their attention. " +
      "You choose WHO among the team but NOT the address — it is always one of the team members, " +
      "never anyone else. This starts a new email thread; when they reply, it comes back to you " +
      "with the full history attached. " +
      "This is separate from replying to whoever wrote in (use `reply` for that).",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          enum: TO_ENUM,
          description: "Which team member to email, by id — or \"all\" for everyone. Defaults to all.",
        },
        subject: { type: "string", description: "Email subject line." },
        message: {
          type: "string",
          description:
            "The email body as plain text. Include the context they need — who this concerns and what you need " +
            "from them. Omit this if you are supplying `html`; the plain-text version is then derived from it.",
        },
        html: {
          type: "string",
          description:
            "Optional HTML body, for mail that benefits from real formatting — headings, lists, tables, links, emphasis. " +
            "Write a body fragment only (no <html>, <head>, or <body> wrapper) and put ALL styling in inline `style=` " +
            "attributes: mail clients strip <style> blocks and ignore external stylesheets, so a <style> rule simply " +
            "will not apply. No scripts, no remote images. Prefer plain `message` for a short note — HTML is for when " +
            "the structure genuinely helps them read it.",
        },
      },
      required: ["subject"],
    },
  },
];

async function handleEmailTeam(args) {
  const { to = "all", subject, message, html } = args;

  if (!subject || (!message && !html)) {
    return {
      content: [
        {
          type: "text",
          text: "email_team requires `subject` and a body — either `message` or `html`.",
        },
      ],
      isError: true,
    };
  }

  // Forward source-task facts (if this run came from a task) so the created
  // thread is linked for reply continuity — same as send_email.
  let threadContext;
  const rawCtx = process.env.CADDIE_THREAD_CONTEXT;
  if (rawCtx) {
    try { threadContext = JSON.parse(rawCtx); } catch { /* ignore malformed */ }
  }

  let result;
  try {
    const res = await fetch(`${PORTAL_URL}/api/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "email_team",
        to,
        subject,
        ...(message && { message }),
        ...(html && { html }),
        ...(threadContext && { threadContext }),
      }),
    });
    result = await res.json();
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to reach the portal: ${err.message}` }], isError: true };
  }

  const { sent = [], missing = [], failed = [] } = result;
  const parts = [];
  if (sent.length) parts.push(`Sent to ${sent.join(" and ")}.`);
  if (missing.length) parts.push(`No address configured for ${missing.join(", ")}.`);
  if (failed.length) parts.push(`Failed for ${failed.join("; ")}.`);
  if (!parts.length) parts.push(result.error ?? "Nothing was sent.");

  return {
    content: [{ type: "text", text: parts.join(" ") }],
    isError: sent.length === 0,
  };
}

const handlers = {
  email_team: handleEmailTeam,
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
