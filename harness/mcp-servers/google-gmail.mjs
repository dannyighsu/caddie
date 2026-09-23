/**
 * Google Gmail MCP Server (read-only)
 *
 * Minimal MCP server exposing search_emails, get_email and download_attachment.
 * get_email lists a message's attachments (name, type, size); download_attachment
 * saves one into the agent's workspace so it can be opened.
 * Shares OAuth2 tokens with Google Calendar (credentials/google-calendar-tokens.json).
 * Requires gmail.readonly scope — re-run google-auth.ts to authorize.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { google } from "googleapis";
import { mkdir, readFile, writeFile } from "fs/promises";
import { resolve, dirname, relative } from "path";
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

/**
 * Crude HTML → text, for HTML-only mail where there is no text/plain part.
 * Good enough to read; the inbound path uses a proper converter.
 */
function htmlToText(html) {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** First text/html body in the payload, decoded. */
function extractHtmlBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBody(payload.body.data);
  }
  for (const part of payload.parts ?? []) {
    const result = extractHtmlBody(part);
    if (result) return result;
  }
  return "";
}

/**
 * Every file part of a message: attached files and inline (`cid:`) images.
 * Mirrors extractParts in northstar/lib/gmail/parts.ts — containers and the
 * unnamed text/plain / text/html bodies are skipped, every other leaf with bytes
 * behind it is a file.
 */
function listAttachments(payload) {
  const out = [];
  const walk = (p) => {
    const mimeType = p.mimeType ?? "";
    const filename = p.filename ?? "";
    const isContainer = (p.parts?.length ?? 0) > 0 || mimeType.startsWith("multipart/");
    const isBody = !filename && (mimeType === "text/plain" || mimeType === "text/html");
    if (!isContainer && !isBody && (p.body?.attachmentId || p.body?.data)) {
      out.push({ partId: p.partId, filename, mimeType, sizeBytes: p.body?.size ?? 0, part: p });
    }
    for (const sub of p.parts ?? []) walk(sub);
  };
  if (payload) walk(payload);
  return out;
}

/**
 * Today's artifacts directory in the agent's workspace, matching the layout
 * the inbound email path uses (runs/YYYY-MM/D_dayname/artifacts/email-<thread>).
 */
function artifactsDir(workspace, threadId) {
  const pst = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const month = `${pst.getFullYear()}-${String(pst.getMonth() + 1).padStart(2, "0")}`;
  const day = `${pst.getDate()}_${pst.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase()}`;
  return resolve(workspace, "runs", month, day, "artifacts", `email-${threadId}`);
}

/**
 * Sender-supplied filenames arrive verbatim; strip directory components and
 * anything outside a conservative set so the name can't escape the directory.
 * Prefixed with the message id, as the inbound path does, so two messages in a
 * thread attaching "scan.pdf" don't overwrite each other.
 */
function safeFileName(filename, messageId, partId) {
  const base = (filename.split(/[\\/]/).pop() ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 64);
  return `${messageId}-${base || `part-${partId}`}`;
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
  "Get the full content of a specific email by its message ID, including its attachments (partId, filename, mimeType, sizeBytes). Use download_attachment to open one.",
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

    const body =
      extractTextBody(msg.data.payload) || htmlToText(extractHtmlBody(msg.data.payload));
    const attachments = listAttachments(msg.data.payload).map(
      ({ partId, filename, mimeType, sizeBytes }) => ({ partId, filename, mimeType, sizeBytes })
    );

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
              attachments,
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

server.tool(
  "download_attachment",
  "Save one attachment of an email into your workspace so you can open it. Returns the saved file's path relative to your working directory.",
  {
    messageId: z.string().describe("The Gmail message ID"),
    partId: z.string().describe("The attachment's partId, from get_email's attachments list"),
  },
  async ({ messageId, partId }) => {
    const gmail = await getAuthenticatedClient();

    // Re-read the message rather than taking an attachmentId from the model:
    // Gmail's attachment ids aren't stable across fetches, but part ids are.
    const msg = await gmail.users.messages.get({ userId: "me", id: messageId, format: "full" });
    const found = listAttachments(msg.data.payload).find((a) => a.partId === partId);
    if (!found) {
      return {
        content: [{ type: "text", text: `No attachment with partId "${partId}" on message ${messageId}.` }],
        isError: true,
      };
    }

    let data = found.part.body?.data;
    if (!data && found.part.body?.attachmentId) {
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId,
        id: found.part.body.attachmentId,
      });
      data = res.data.data;
    }
    if (!data) {
      return {
        content: [{ type: "text", text: `Attachment "${found.filename}" has no content to download.` }],
        isError: true,
      };
    }

    const workspace = process.env.NORTHSTAR_WORKSPACE || process.cwd();
    const dir = artifactsDir(workspace, msg.data.threadId);
    await mkdir(dir, { recursive: true });
    const filePath = resolve(dir, safeFileName(found.filename, messageId, partId));
    const bytes = Buffer.from(data, "base64url");
    await writeFile(filePath, bytes);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              path: relative(workspace, filePath),
              filename: found.filename,
              mimeType: found.mimeType,
              sizeBytes: bytes.length,
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
