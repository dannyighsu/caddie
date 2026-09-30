#!/usr/bin/env node
/**
 * Fixture-backed stand-ins for the Google capabilities (google-calendar,
 * google-gmail) in eval runs. Same tool names as production, so the model calls
 * them the same way; reads come from the case's `fixtures`, writes succeed
 * without touching anything. What was called is read back from the session
 * transcript, so this server doesn't log.
 *
 * Env:
 *   EVAL_STUB_KIND      — "calendar" | "gmail"
 *   EVAL_FIXTURES_FILE  — JSON: { calendar?: Event[], gmail?: Email[] }
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
        // Newest first, as Gmail returns them — fixture order would let
        // maxResults cut off the most recent thread.
        .sort((a, b) => new Date(b.date ?? 0) - new Date(a.date ?? 0))
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

await server.connect(new StdioServerTransport());
