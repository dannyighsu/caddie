#!/usr/bin/env node

/**
 * Artifacts MCP Server
 *
 * One tool, `publish_artifact`: put workspace files on a password-protected
 * link that opens from any device. The rules for what can be published are in
 * artifacts-publish.mjs. The credentials reach this server through its
 * capability JSON and never reach the agent's own environment.
 *
 * Env:
 *   ARTIFACTS_ORIGIN             — Where the Worker is served, e.g. https://artifacts.example.com
 *   ARTIFACTS_PASSWORD           — The Worker's PW_SHARED secret, given to recipients
 *   ARTIFACTS_R2_ACCOUNT_ID      — Cloudflare account id
 *   ARTIFACTS_R2_ACCESS_KEY_ID   — R2 token scoped to the bucket
 *   ARTIFACTS_R2_SECRET_ACCESS_KEY
 *   CADDIE_WORKSPACE             — The agent's working directory (injected by the launcher)
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { publish } from "./artifacts-publish.mjs";

const WORKSPACE = process.env.CADDIE_WORKSPACE || process.cwd();

const server = new Server({ name: "artifacts", version: "0.1.0" }, { capabilities: { tools: {} } });

const tools = [
  {
    name: "publish_artifact",
    description:
      "Publish files as a password-protected web link that opens from any device: a web page, a PDF, or a set of files meant for someone else. " +
      "Files must be in a run's artifacts/ directory, so write or copy them there first. " +
      "Everything you pass becomes one artifact, with its folder structure kept, so a page's relative links to its images, styles and scripts keep working. " +
      "If there's an index.html at the top, you get one link to the page; otherwise you get one link per file. " +
      "Returns the link(s) and the password, and has already checked that the link opens. " +
      "Anyone with both can read the content, and a published artifact stays up after this run.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description:
            "Files or directories relative to your working directory, e.g. [\"runs/2026-09/29_tuesday/artifacts/report.pdf\"]. Pass a directory to publish everything in it. Dotfiles are skipped.",
        },
      },
      required: ["paths"],
    },
  },
];

async function handlePublish({ paths }) {
  const { files, links } = await publish(WORKSPACE, paths, {
    origin: process.env.ARTIFACTS_ORIGIN,
    password: process.env.ARTIFACTS_PASSWORD,
    accountId: process.env.ARTIFACTS_R2_ACCOUNT_ID,
    accessKeyId: process.env.ARTIFACTS_R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.ARTIFACTS_R2_SECRET_ACCESS_KEY,
  });
  const text = [
    `Published ${files.length} file(s): ${files.join(", ")}`,
    "",
    ...links,
    "",
    `Password: ${process.env.ARTIFACTS_PASSWORD}`,
    "The same password opens everything you've published, so send it only to the people this is for.",
  ].join("\n");
  return { content: [{ type: "text", text }] };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (name !== "publish_artifact") {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    return await handlePublish(args ?? {});
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
