/**
 * Google Gmail MCP Server (read-only)
 *
 * Minimal MCP server exposing search_emails and get_email tools.
 * Shares OAuth2 tokens with Google Calendar (credentials/google-calendar-tokens.json).
 * Requires gmail.readonly scope — re-run google-auth.ts to authorize.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { readFile, writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(__dirname, "..");
const TOKENS_FILE = resolve(HARNESS_ROOT, "credentials/google-calendar-tokens.json");

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri =
    process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/oauth2callback";

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function getAuthenticatedClient() {
  const oauth2Client = getOAuth2Client();
  const content = await readFile(TOKENS_FILE, "utf-8");
  const tokens = JSON.parse(content);
  oauth2Client.setCredentials(tokens);

  // Auto-save refreshed tokens
  oauth2Client.on("tokens", async (newTokens) => {
    if (newTokens.access_token) {
      await writeFile(
        TOKENS_FILE,
        JSON.stringify(
          {
            access_token: newTokens.access_token,
            refresh_token: newTokens.refresh_token ?? tokens.refresh_token,
            expiry_date: newTokens.expiry_date ?? undefined,
          },
          null,
          2
        )
      );
    }
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
}

/**
 * Decode a base64url-encoded email body part.
 */
function decodeBody(data) {
  if (!data) return "";
  return Buffer.from(data, "base64url").toString("utf-8");
}

/**
 * Extract plain text body from a message payload (handles multipart).
 */
function extractTextBody(payload) {
  if (!payload) return "";

  // Simple message with body data
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }

  // Multipart — recurse into parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return decodeBody(part.body.data);
      }
    }
    // If no text/plain, try nested multipart
    for (const part of payload.parts) {
      const result = extractTextBody(part);
      if (result) return result;
    }
  }

  return "";
}

// --- MCP Server ---

const server = new McpServer({
  name: "google-gmail",
  version: "1.0.0",
});

server.tool(
  "search_emails",
  "Search Gmail messages. Returns a list of matching emails with subject, sender, date, and snippet.",
  {
    query: z
      .string()
      .describe(
        "Gmail search query (same syntax as Gmail search bar). Examples: 'from:alice subject:invoice', 'flight confirmation', 'is:unread after:2025/01/01'"
      ),
    maxResults: z
      .number()
      .optional()
      .describe("Maximum number of results to return (default: 10, max: 20)"),
  },
  async ({ query, maxResults }) => {
    const gmail = await getAuthenticatedClient();

    const listResponse = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: Math.min(maxResults ?? 10, 20),
    });

    const messageIds = listResponse.data.messages || [];
    if (messageIds.length === 0) {
      return {
        content: [{ type: "text", text: "No emails found matching the query." }],
      };
    }

    // Fetch metadata for each message
    const emails = await Promise.all(
      messageIds.map(async ({ id }) => {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });

        const headers = msg.data.payload?.headers || [];
        const getHeader = (name) =>
          headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
            ?.value || "";

        return {
          id: msg.data.id,
          threadId: msg.data.threadId,
          snippet: msg.data.snippet,
          from: getHeader("From"),
          to: getHeader("To"),
          subject: getHeader("Subject"),
          date: getHeader("Date"),
          labelIds: msg.data.labelIds,
        };
      })
    );

    return {
      content: [{ type: "text", text: JSON.stringify(emails, null, 2) }],
    };
  }
);

server.tool(
  "get_email",
  "Get the full content of a specific email by its message ID.",
  {
    messageId: z.string().describe("The Gmail message ID (from search_emails results)"),
  },
  async ({ messageId }) => {
    const gmail = await getAuthenticatedClient();

    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    const headers = msg.data.payload?.headers || [];
    const getHeader = (name) =>
      headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
        ?.value || "";

    const body = extractTextBody(msg.data.payload);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: msg.data.id,
              threadId: msg.data.threadId,
              from: getHeader("From"),
              to: getHeader("To"),
              subject: getHeader("Subject"),
              date: getHeader("Date"),
              body: body || "(no text body)",
              labelIds: msg.data.labelIds,
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
