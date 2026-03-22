import { google, calendar_v3 } from "googleapis";
import {
  getOAuthCredential,
  updateOAuthTokens,
} from "../db/oauth-repository";
import { getAppConfig } from "../config/app-config";

export interface CalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  attendees?: string[];
}

async function getAuthenticatedClient(): Promise<ReturnType<
  typeof google.calendar
> | null> {
  const creds = await getOAuthCredential("google");
  if (!creds) {
    console.error("[GCal] No Google credentials found");
    return null;
  }

  const config = getAppConfig();
  const oauth2Client = new google.auth.OAuth2(
    config.GOOGLE_CLIENT_ID,
    config.GOOGLE_CLIENT_SECRET,
    config.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
  });

  // Handle token refresh
  oauth2Client.on("tokens", async (tokens) => {
    if (tokens.access_token) {
      const expiresAt = tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : null;
      await updateOAuthTokens(
        "google",
        tokens.access_token,
        expiresAt,
        tokens.refresh_token
      );
      console.log("[GCal] Tokens refreshed and stored");
    }
  });

  return google.calendar({ version: "v3", auth: oauth2Client });
}

export async function getTodayEvents(): Promise<CalendarEvent[]> {
  const calendar = await getAuthenticatedClient();
  if (!calendar) return [];

  const now = new Date();
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date(now);
  endOfDay.setHours(23, 59, 59, 999);

  try {
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: startOfDay.toISOString(),
      timeMax: endOfDay.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    return (response.data.items || []).map(formatEvent);
  } catch (error) {
    console.error("[GCal] Error fetching today's events:", error);
    return [];
  }
}

export async function getUpcomingEvents(
  maxResults: number = 10
): Promise<CalendarEvent[]> {
  const calendar = await getAuthenticatedClient();
  if (!calendar) return [];

  try {
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
    });

    return (response.data.items || []).map(formatEvent);
  } catch (error) {
    console.error("[GCal] Error fetching upcoming events:", error);
    return [];
  }
}

export async function getEventsInRange(
  startDate: Date,
  endDate: Date
): Promise<CalendarEvent[]> {
  const calendar = await getAuthenticatedClient();
  if (!calendar) return [];

  try {
    const response = await calendar.events.list({
      calendarId: "primary",
      timeMin: startDate.toISOString(),
      timeMax: endDate.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    return (response.data.items || []).map(formatEvent);
  } catch (error) {
    console.error("[GCal] Error fetching events in range:", error);
    return [];
  }
}

function formatEvent(event: calendar_v3.Schema$Event): CalendarEvent {
  return {
    id: event.id || "",
    summary: event.summary || "Untitled",
    description: event.description || undefined,
    start: event.start?.dateTime || event.start?.date || "",
    end: event.end?.dateTime || event.end?.date || "",
    location: event.location || undefined,
    attendees: event.attendees?.map((a) => a.email || "").filter(Boolean),
  };
}

export function formatEventsForPrompt(events: CalendarEvent[]): string {
  if (events.length === 0) {
    return "No calendar events.";
  }

  return events
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
}
