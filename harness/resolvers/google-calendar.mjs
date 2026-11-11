/**
 * Google Calendar Resolver
 *
 * Fetches today's calendar events via the Google Calendar API
 * and returns them as a formatted string for template injection.
 *
 * Auth: OAuth 2.0 with file-based token storage.
 * Setup: Run `harness/scripts/google-auth.ts` once to authorize.
 */

import { google } from "googleapis";
import { readFile, writeFile } from "fs/promises";
import { resolve } from "path";

const TOKENS_FILE = "credentials/google-calendar-tokens.json";

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI ?? "http://localhost:3000/oauth2callback";

  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set");
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function loadTokens(harnessRoot) {
  try {
    const tokensPath = resolve(harnessRoot, TOKENS_FILE);
    const content = await readFile(tokensPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveTokens(harnessRoot, tokens) {
  const tokensPath = resolve(harnessRoot, TOKENS_FILE);
  await writeFile(tokensPath, JSON.stringify(tokens, null, 2));
}

function formatEventsForPrompt(events) {
  const header = "### Today's Calendar";
  if (events.length === 0) {
    return `${header}\nNo calendar events today.`;
  }

  const lines = events
    .map((event) => {
      const startTime = new Date(event.start).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      });
      const endTime = new Date(event.end).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/Los_Angeles",
      });
      let line = `- ${startTime} - ${endTime}: ${event.summary}`;
      if (event.location) {
        line += ` (${event.location})`;
      }
      return line;
    })
    .join("\n");
  return `${header}\n${lines}`;
}

const resolver = {
  async resolve(config) {
    try {
      const oauth2Client = getOAuth2Client();
      const tokens = await loadTokens(config.harnessRoot);

      if (!tokens) {
        console.warn("[GCal Resolver] No tokens found. Run harness/scripts/google-auth.ts to authorize.");
        return { calendarEvents: "### Today's Calendar\nCalendar not connected. Run the Google auth setup." };
      }

      oauth2Client.setCredentials(tokens);

      oauth2Client.on("tokens", async (newTokens) => {
        if (newTokens.access_token) {
          await saveTokens(config.harnessRoot, {
            access_token: newTokens.access_token,
            refresh_token: newTokens.refresh_token ?? tokens.refresh_token,
            expiry_date: newTokens.expiry_date ?? undefined,
          });
        }
      });

      const calendar = google.calendar({ version: "v3", auth: oauth2Client });

      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(now);
      endOfDay.setHours(23, 59, 59, 999);

      const response = await calendar.events.list({
        calendarId: "primary",
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = (response.data.items || []).map((event) => ({
        summary: event.summary || "Untitled",
        start: event.start?.dateTime || event.start?.date || "",
        end: event.end?.dateTime || event.end?.date || "",
        location: event.location || undefined,
      }));

      return { calendarEvents: formatEventsForPrompt(events) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[GCal Resolver] Failed to fetch calendar: ${message}`);
      return { calendarEvents: "### Today's Calendar\nUnable to fetch calendar events." };
    }
  },
};

export default resolver;
