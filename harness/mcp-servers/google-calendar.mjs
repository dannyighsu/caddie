/**
 * Google Calendar MCP Server
 *
 * Minimal MCP server exposing list_events, create_event, update_event, and
 * delete_event tools. Reuses the existing OAuth2 tokens from harness/credentials/.
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

  return google.calendar({ version: "v3", auth: oauth2Client });
}

// --- MCP Server ---

const server = new McpServer({
  name: "google-calendar",
  version: "1.0.0",
});

server.tool(
  "list_events",
  "List Google Calendar events for a date range. Defaults to today.",
  {
    startDate: z
      .string()
      .optional()
      .describe("Start date in ISO 8601 format (e.g. 2025-01-15). Defaults to today."),
    endDate: z
      .string()
      .optional()
      .describe("End date in ISO 8601 format. Defaults to end of startDate."),
    calendarId: z
      .string()
      .optional()
      .describe("Calendar ID. Defaults to 'primary'."),
  },
  async ({ startDate, endDate, calendarId }) => {
    const calendar = await getAuthenticatedClient();

    const start = startDate ? new Date(startDate) : new Date();
    start.setHours(0, 0, 0, 0);

    const end = endDate ? new Date(endDate) : new Date(start);
    end.setHours(23, 59, 59, 999);

    const response = await calendar.events.list({
      calendarId: calendarId ?? "primary",
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    const events = (response.data.items || []).map((event) => ({
      id: event.id,
      summary: event.summary || "Untitled",
      start: event.start?.dateTime || event.start?.date || "",
      end: event.end?.dateTime || event.end?.date || "",
      location: event.location || undefined,
      description: event.description || undefined,
      attendees: event.attendees?.map((a) => ({
        email: a.email,
        responseStatus: a.responseStatus,
      })),
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(events, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "create_event",
  "Create a new Google Calendar event on YOUR OWN calendar. To also place it on someone else's calendar (e.g. a team member's), add their email to `attendees` — they receive an invitation that, once accepted, puts the event on their calendar. Without attendees, the event lives only on your calendar.",
  {
    summary: z.string().describe("Event title"),
    startTime: z
      .string()
      .describe("Start time in ISO 8601 format (e.g. 2025-01-15T10:00:00-08:00)"),
    endTime: z
      .string()
      .describe("End time in ISO 8601 format"),
    description: z.string().optional().describe("Event description"),
    location: z.string().optional().describe("Event location"),
    attendees: z
      .array(z.string())
      .optional()
      .describe("List of attendee email addresses"),
    addMeet: z
      .boolean()
      .optional()
      .describe(
        "Add a Google Meet video link. Defaults to true for group meetings (2+ attendees) and false otherwise. Set explicitly to force it on or off (e.g. false for an in-person event)."
      ),
    calendarId: z
      .string()
      .optional()
      .describe("Calendar ID. Defaults to 'primary'."),
  },
  async ({ summary, startTime, endTime, description, location, attendees, addMeet, calendarId }) => {
    const calendar = await getAuthenticatedClient();

    // Group meetings (2+ attendees) get a Google Meet link by default; overridable via addMeet.
    const wantMeet = addMeet ?? (attendees?.length ?? 0) >= 2;

    const event = {
      summary,
      start: { dateTime: startTime },
      end: { dateTime: endTime },
      description: description || undefined,
      location: location || undefined,
      attendees: attendees?.map((email) => ({ email })),
      // Every event is editable by its attendees — defaulted here in the tool so
      // it always applies and never needs to be a caller/agent concern.
      guestsCanModify: true,
    };

    if (wantMeet) {
      event.conferenceData = {
        createRequest: {
          // Unique per request; Google echoes it back to correlate the conference it creates.
          requestId: `meet-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      };
    }

    const response = await calendar.events.insert({
      calendarId: calendarId ?? "primary",
      requestBody: event,
      sendUpdates: attendees?.length ? "all" : "none",
      // Must be 1 for Google to honor conferenceData.createRequest and mint a Meet link.
      conferenceDataVersion: wantMeet ? 1 : 0,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: response.data.id,
              summary: response.data.summary,
              start: response.data.start,
              end: response.data.end,
              htmlLink: response.data.htmlLink,
              hangoutLink: response.data.hangoutLink || undefined,
              guestsCanModify: response.data.guestsCanModify ?? undefined,
              attendees: response.data.attendees?.map((a) => ({
                email: a.email,
                responseStatus: a.responseStatus,
              })),
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
  "update_event",
  "Update an existing Google Calendar event. Only the fields you provide are changed; omitted fields are left as-is. Attendees are automatically re-notified of the change.",
  {
    eventId: z
      .string()
      .describe("The id of the event to update (returned by create_event or list_events)."),
    summary: z.string().optional().describe("New event title."),
    startTime: z
      .string()
      .optional()
      .describe("New start time in ISO 8601 format (e.g. 2026-07-25T10:00:00-07:00)."),
    endTime: z.string().optional().describe("New end time in ISO 8601 format."),
    description: z.string().optional().describe("New event description."),
    location: z.string().optional().describe("New event location."),
    attendees: z
      .array(z.string())
      .optional()
      .describe("Replacement list of attendee email addresses. Replaces the existing list entirely."),
    calendarId: z
      .string()
      .optional()
      .describe("Calendar ID. Defaults to 'primary'."),
  },
  async ({ eventId, summary, startTime, endTime, description, location, attendees, calendarId }) => {
    const calendar = await getAuthenticatedClient();

    // Build a partial requestBody: only include fields the caller provided so
    // events.patch leaves everything else untouched.
    const requestBody = {};
    if (summary !== undefined) requestBody.summary = summary;
    if (startTime !== undefined) requestBody.start = { dateTime: startTime };
    if (endTime !== undefined) requestBody.end = { dateTime: endTime };
    if (description !== undefined) requestBody.description = description;
    if (location !== undefined) requestBody.location = location;
    if (attendees !== undefined) requestBody.attendees = attendees.map((email) => ({ email }));

    const response = await calendar.events.patch({
      calendarId: calendarId ?? "primary",
      eventId,
      requestBody,
      // Always notify attendees of updates — that's the point of a managed event.
      sendUpdates: "all",
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              id: response.data.id,
              summary: response.data.summary,
              start: response.data.start,
              end: response.data.end,
              htmlLink: response.data.htmlLink,
              attendees: response.data.attendees?.map((a) => ({
                email: a.email,
                responseStatus: a.responseStatus,
              })),
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
  "delete_event",
  "Delete (cancel) a Google Calendar event. Attendees are automatically sent a cancellation notice.",
  {
    eventId: z
      .string()
      .describe("The id of the event to delete (returned by create_event or list_events)."),
    calendarId: z
      .string()
      .optional()
      .describe("Calendar ID. Defaults to 'primary'."),
  },
  async ({ eventId, calendarId }) => {
    const calendar = await getAuthenticatedClient();

    await calendar.events.delete({
      calendarId: calendarId ?? "primary",
      eventId,
      // Notify attendees so the event is removed from their calendars too.
      sendUpdates: "all",
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ deleted: true, eventId }, null, 2),
        },
      ],
    };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
