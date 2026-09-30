#!/usr/bin/env node

/**
 * Reply MCP Server
 *
 * A single, minimal-privilege tool for responding to the person the agent is
 * currently talking to — in the SAME conversation they contacted it on. The
 * destination is NOT chosen by the agent: the harness injects it via
 * IGNIS_REPLY_TARGET, so a reply can only ever land in the current thread.
 * That makes it safe to grant at every trust tier (including guest): it can't
 * reach anyone new, only answer whoever wrote in — exactly what auto-delivery
 * did before, but as an explicit, skippable action.
 *
 * Contrast with `send_email` (a separate, team-only capability), which
 * starts arbitrary new mail and therefore stays gated to authenticated senders.
 *
 * Delivery is proxied through the Ignis control API (`reply` action) so the
 * send is recorded on the local conversation — keeping replayed history a
 * faithful copy of the real, user-visible thread.
 *
 * Env:
 *   PORTAL_URL              — Base URL for the portal control API (default: http://localhost:3000)
 *   IGNIS_REPLY_TARGET  — JSON reply target injected by the harness for this run
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PORTAL_URL = process.env.PORTAL_URL || "http://localhost:3000";

const server = new Server(
  { name: "reply", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "reply",
    description:
      "Reply to the person you are currently talking to, in the SAME thread they contacted you on. " +
      "This is how you respond to a message you received — it delivers in-thread, correctly threaded. " +
      "You do not choose the destination: it is always the current conversation. " +
      "Your final text output is used only for logging/tracing, so you MUST call this tool to actually say anything. " +
      "If no response is warranted (e.g. a group thread where you weren't really addressed — check the email envelope in your run context), simply DO NOT call this tool. " +
      "You may call it more than once to send multiple messages.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The message body to send into the current thread.",
        },
        replyAll: {
          type: "boolean",
          description:
            "Email threads only: whether to reply to everyone already on the thread (original To + Cc) rather than just the sender. " +
            "Defaults to true, so a group thread stays a group thread. This never reaches anyone new — only people already copied on the thread. " +
            "Set false to answer only the person who wrote in (e.g. a deliberately private reply). Ignored on non-email channels.",
        },
      },
      required: ["message"],
    },
  },
];

async function handleReply(args) {
  const { message, replyAll } = args;

  if (!message) {
    return {
      content: [{ type: "text", text: "reply requires a `message`." }],
      isError: true,
    };
  }

  // The reply target is injected by the harness (not agent-supplied), so a reply
  // can only land in the conversation this run is handling.
  const rawTarget = process.env.IGNIS_REPLY_TARGET;
  if (!rawTarget) {
    return {
      content: [
        {
          type: "text",
          text:
            "This run has no reply target — `reply` doesn't apply here (e.g. a portal " +
            "or scheduled run). Respond with your final message instead; it is delivered automatically.",
        },
      ],
      isError: true,
    };
  }
  let replyTarget;
  try {
    replyTarget = JSON.parse(rawTarget);
  } catch {
    return {
      content: [{ type: "text", text: "Reply target is malformed." }],
      isError: true,
    };
  }

  const res = await fetch(`${PORTAL_URL}/api/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reply", replyTarget, message, replyAll }),
  });

  const result = await res.json();

  if (!result.success) {
    return {
      content: [{ type: "text", text: `Failed to send reply: ${result.error ?? "unknown error"}` }],
      isError: true,
    };
  }

  return {
    content: [{ type: "text", text: "Reply sent." }],
  };
}

const handlers = {
  reply: handleReply,
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
