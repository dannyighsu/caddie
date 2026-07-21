/**
 * iCalendar (RFC 5545) event invite generation.
 *
 * Produces a `METHOD:REQUEST` VEVENT that, when attached to an email as
 * `text/calendar`, renders as a native calendar invitation (Yes/No/Maybe) in
 * Gmail, Outlook, and Apple Mail. The sender is the organizer; there is no
 * backing calendar server, so RSVP responses arrive back as `METHOD:REPLY`
 * emails to the organizer's inbox rather than updating a calendar UI.
 *
 * All timestamps are emitted in UTC (`...Z`) so no VTIMEZONE block is needed.
 */

export interface CalendarEvent {
  /** Globally-unique, stable id for the event (used for updates/cancellations). */
  uid: string;
  summary: string;
  /** ISO 8601 start, e.g. "2026-07-25T10:00:00-07:00". */
  startTime: string;
  /** ISO 8601 end. */
  endTime: string;
  description?: string;
  location?: string;
  /** Organizer email address (the sending inbox). */
  organizer: string;
  /** Attendee email addresses. */
  attendees: string[];
}

/** Format an ISO 8601 timestamp as an iCalendar UTC date-time: YYYYMMDDTHHMMSSZ. */
function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) throw new Error(`Invalid date-time: ${iso}`);
  // 2026-07-25T17:00:00.000Z -> 20260725T170000Z
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Escape a TEXT value per RFC 5545 §3.3.11 (backslash, semicolon, comma, newline). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/**
 * Fold a content line to <=75 octets per RFC 5545 §3.1, splitting on octet
 * boundaries without breaking a UTF-8 multibyte sequence. Continuation lines
 * are prefixed with a single space.
 */
function foldLine(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;

  // First line takes 75 octets; continuations take 74 (one octet is the leading space).
  const chunks: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // Back off if we'd split mid-sequence (continuation bytes are 0b10xxxxxx).
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    chunks.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
    limit = 74;
  }
  return chunks.join("\r\n ");
}

/**
 * Build a complete `text/calendar` document (METHOD:REQUEST) for the event.
 * Returns the raw ICS string with CRLF line endings.
 */
export function buildEventInvite(event: CalendarEvent): string {
  if (event.attendees.length === 0) {
    throw new Error("A calendar invite requires at least one attendee");
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Northstar//Buri//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${event.uid}`,
    `DTSTAMP:${formatUtc(new Date().toISOString())}`,
    `DTSTART:${formatUtc(event.startTime)}`,
    `DTEND:${formatUtc(event.endTime)}`,
    `SUMMARY:${escapeText(event.summary)}`,
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    `ORGANIZER:mailto:${event.organizer}`,
    ...event.attendees.map(
      (a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`,
    ),
    "SEQUENCE:0",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];

  return lines.map(foldLine).join("\r\n") + "\r\n";
}
