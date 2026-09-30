#!/usr/bin/env node
/**
 * Fixture-backed stand-ins for the Google capabilities (google-calendar,
 * google-gmail) in eval runs. Same tool names as production, so the model calls
 * them the same way; reads come from the case's `fixtures`, writes succeed
 * without touching anything. What was called is read back from the session
 * transcript, so this server doesn't log.
 *
 * `rag` stands in for local-rag (mcp-local-rag) with its read tools only, as
 * production mounts it: a keyword search over the case's seeded documents,
 * which the sandbox also writes into the workspace.
 *
 * Env:
 *   EVAL_STUB_KIND      — "calendar" | "gmail" | "rag"
 *   EVAL_FIXTURES_FILE  — JSON: { calendar?: Event[], gmail?: Email[], rag?: {path, text}[], workspace }
 */

import { readFileSync } from "fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const kind = process.env.EVAL_STUB_KIND;
let fixtures = {};
try {
  fixtures = JSON.parse(readFileSync(process.env.EVAL_FIXTURES_FILE ?? "", "utf-8"));
} catch {
  fixtures = {};
}
const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });

/**
 * A small subset of Gmail search: clauses joined by OR; within a clause every
 * term must match. `from:`, `to:`, `cc:` and `subject:` match that field;
 * other operators (is:, after:, label:, …) are ignored; bare words and
 * "quoted phrases" match anywhere.
 */
function matchesQuery(e, query) {
  const fields = { from: e.from, to: `${e.to ?? ""} ${e.cc ?? ""}`, cc: e.cc, subject: e.subject };
  const hay = `${e.from} ${e.to} ${e.cc ?? ""} ${e.subject} ${e.body}`.toLowerCase();
  return query.split(/\s+OR\s+/).some((clause) => {
    const terms = clause.match(/(\w+:)?("[^"]*"|\S+)/g) ?? [];
    return terms.every((raw) => {
      const m = raw.match(/^(\w+):(.*)$/);
      const key = m?.[1]?.toLowerCase();
      const val = (m ? m[2] : raw).replace(/^"|"$/g, "").replace(/[()]/g, "").toLowerCase();
      if (!val) return true;
      if (key && key in fields) return String(fields[key] ?? "").toLowerCase().includes(val);
      if (key) return true;
      return hay.includes(val);
    });
  });
}

const server = new McpServer({ name: `eval-stub-${kind}`, version: "1.0.0" });

if (kind === "calendar") {
  const events = fixtures.calendar ?? [];
  let nextId = 1;
  server.tool(
    "list_events",
    "List Google Calendar events for a date range. Defaults to today.",
    {
      startDate: z.string().optional().describe("Start date in ISO 8601 format (e.g. 2025-01-15)."),
      endDate: z.string().optional().describe("End date in ISO 8601 format. Defaults to end of startDate."),
      calendarId: z.string().optional(),
    },
    async ({ startDate, endDate }) => {
      // Compare on the date part so "2026-09-25" covers that whole day.
      const day = (s) => (s ?? "").slice(0, 10);
      const lo = day(startDate);
      const hi = day(endDate) || lo;
      const hits = events.filter((e) => {
        const d = day(e.start);
        return (!lo || d >= lo) && (!hi || d <= hi);
      });
      return text(hits.length ? hits : "No events found in that range.");
    }
  );
  server.tool(
    "create_event",
    "Create a calendar event.",
    {
      summary: z.string(),
      startTime: z.string(),
      endTime: z.string(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      addMeet: z.boolean().optional(),
      calendarId: z.string().optional(),
    },
    async (args) => text({ id: `eval-event-${nextId++}`, status: "confirmed", ...args })
  );
  server.tool(
    "update_event",
    "Update a calendar event.",
    {
      eventId: z.string(),
      summary: z.string().optional(),
      startTime: z.string().optional(),
      endTime: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      attendees: z.array(z.string()).optional(),
      calendarId: z.string().optional(),
    },
    async (args) => text({ ...args, status: "confirmed" })
  );
  server.tool(
    "delete_event",
    "Delete a calendar event.",
    { eventId: z.string(), calendarId: z.string().optional() },
    async ({ eventId }) => text(`Deleted ${eventId}.`)
  );
}

if (kind === "gmail") {
  const emails = fixtures.gmail ?? [];
  server.tool(
    "search_emails",
    "Search Gmail messages. Returns a list of matching emails with subject, sender, date, and snippet.",
    { query: z.string(), maxResults: z.number().optional() },
    async ({ query, maxResults }) => {
      const hits = emails
        .filter((e) => matchesQuery(e, query))
        .slice(0, Math.min(maxResults ?? 10, 20))
        .map(({ body, ...meta }) => ({ ...meta, snippet: (body ?? "").replace(/\s+/g, " ").slice(0, 200) }));
      return text(hits.length ? hits : "No emails found matching the query.");
    }
  );
  server.tool(
    "get_email",
    "Get the full content of a specific email by its message ID, including its attachments.",
    { messageId: z.string() },
    async ({ messageId }) => {
      const e = emails.find((x) => x.id === messageId);
      return e ? text({ attachments: [], ...e }) : text(`No email with id ${messageId}.`);
    }
  );
  server.tool(
    "download_attachment",
    "Save one attachment of an email into your workspace so you can open it.",
    { messageId: z.string(), partId: z.string() },
    async () => text("Attachment not available in this environment.")
  );
}

if (kind === "rag") {
  const docs = (fixtures.rag ?? []).map((d) => ({
    filePath: `${fixtures.workspace}/${d.path}`,
    text: d.text,
    title: d.text.match(/^title:\s*"?(.+?)"?\s*$/m)?.[1] ?? d.path,
  }));
  const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}@.$-]{3,}/gu) ?? []);
  server.tool(
    "query_documents",
    "Search ingested documents. Your query words are embedded and compared against document chunks, then boosted by exact keyword matches. Results include file path, chunk index, text and relevance score.",
    {
      query: z.string(),
      limit: z.number().optional(),
      scope: z.union([z.string(), z.array(z.string())]).optional(),
    },
    async ({ query, limit }) => {
      const terms = new Set(words(query));
      const hits = docs
        .map((d) => {
          const hay = new Set(words(d.text));
          const score = [...terms].filter((t) => hay.has(t)).length;
          return { filePath: d.filePath, chunkIndex: 0, text: d.text, fileTitle: d.title, score: 1 / (1 + score) };
        })
        .filter((h) => h.score < 1)
        .sort((a, b) => a.score - b.score)
        .slice(0, limit ?? 10);
      return text(hits.length ? hits : "No results.");
    }
  );
  server.tool(
    "read_chunk_neighbors",
    "Read the chunks before and after a search result, for more context.",
    { filePath: z.string(), chunkIndex: z.number(), before: z.number().optional(), after: z.number().optional() },
    async ({ filePath }) => {
      const d = docs.find((x) => x.filePath === filePath);
      return text(d ? [{ filePath, chunkIndex: 0, text: d.text, isTarget: true }] : `No document at ${filePath}.`);
    }
  );
  server.tool("list_files", "List ingested files.", {}, async () => text(docs.map((d) => ({ filePath: d.filePath }))));
  server.tool("status", "Index status.", {}, async () => text({ documentCount: docs.length, chunkCount: docs.length }));
}

await server.connect(new StdioServerTransport());
