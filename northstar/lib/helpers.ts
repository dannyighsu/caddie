/**
 * Shared helpers for agent execution paths (gateway, scheduler, messaging).
 */

/**
 * Returns the current time as a fully-qualified, timezone-aware string.
 * Includes the day-of-week, full date, time with AM/PM, the IANA timezone,
 * and the current UTC offset (e.g. PDT or PST). This makes it unambiguous
 * for the agent when interpreting relative times like "at 8pm".
 *
 * Example output:
 *   "Wednesday, April 9, 2026 at 9:53 PM PDT (America/Los_Angeles, UTC-07:00)"
 */
export function currentTimePST(): string {
  const now = new Date();
  const tz = "America/Los_Angeles";

  const formatted = now.toLocaleString("en-US", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });

  // Compute the UTC offset for the user's timezone in ±HH:MM format.
  const offset = computeUtcOffset(now, tz);
  return `${formatted} (${tz}, UTC${offset})`;
}

function computeUtcOffset(date: Date, timeZone: string): string {
  // Use Intl with longOffset to get something like "GMT-07:00", then strip "GMT".
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const offsetPart = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
  return offsetPart.replace(/^GMT/, "") || "+00:00";
}
