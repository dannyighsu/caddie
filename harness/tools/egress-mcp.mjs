#!/usr/bin/env node

/**
 * Egress MCP Server
 *
 * MCP server for outbound messaging — Slack, email, etc.
 * Proxies through the Northstar gateway notify API.
 *
 * Env:
 *   NORTHSTAR_URL — Base URL for the Northstar gateway (default: http://localhost:3000)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const NORTHSTAR_URL = process.env.NORTHSTAR_URL || "http://localhost:3000";

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
];

// --- Tool handlers ---

async function handlePostToSlack(args) {
  const { message, from, channel, threadTs } = args;

  const body = {
    action: "notify",
    channel: "slack",
    message,
    ...(from && { from }),
    ...(channel && { slackChannel: channel }),
    ...(threadTs && { threadTs }),
  };

  const res = await fetch(`${NORTHSTAR_URL}/api/gateway`, {
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

const handlers = {
  post_to_slack: handlePostToSlack,
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
