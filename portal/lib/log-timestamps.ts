/**
 * Console Timestamping
 *
 * Prefixes every process log line with a readable local timestamp (seconds
 * granularity, no milliseconds) so Buri's logs are chronologically legible.
 * Installed once at server startup (see instrumentation.ts) — it wraps the
 * `console` methods in place, so all in-process logging (the portal + the
 * harness it imports) is covered without touching individual call sites.
 *
 * Format matches the cron-block hook log (`date -Iseconds`), e.g.
 *   2026-08-18T12:03:02-07:00 [Messaging] Routed to ...
 * Local machine timezone, so it lines up with the other host logs.
 */

import { format } from "node:util";

/** ISO-8601 local timestamp to seconds with UTC offset, e.g. `2026-08-18T12:03:02-07:00`. */
function logTimestamp(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const offsetMin = -now.getTimezoneOffset(); // minutes east of UTC
  const sign = offsetMin >= 0 ? "+" : "-";
  const absMin = Math.abs(offsetMin);
  const offset = `${sign}${pad(Math.floor(absMin / 60))}:${pad(absMin % 60)}`;
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
    `T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${offset}`
  );
}

/** Console methods that carry a stream (stdout/stderr) worth timestamping. */
const METHODS = ["log", "info", "warn", "error", "debug"] as const;

const INSTALLED = Symbol.for("ignis.logTimestamps.installed");

/**
 * Wrap the console methods so each emitted line begins with a timestamp. Every
 * physical line is prefixed (not just the first), so multi-line output such as
 * stack traces stays aligned. Idempotent: guarded by a global symbol so dev
 * hot-reload can't stack wrappers and double-prefix. Stream routing is preserved
 * (`error`/`warn` still go to stderr) because each wrapper calls its own original.
 */
export function installLogTimestamps(): void {
  const g = globalThis as Record<PropertyKey, unknown>;
  if (g[INSTALLED]) return;
  g[INSTALLED] = true;

  for (const method of METHODS) {
    const original = console[method].bind(console) as (...args: unknown[]) => void;
    console[method] = (...args: unknown[]): void => {
      const ts = logTimestamp();
      // Reproduce console's own formatting, then stamp each resulting line so the
      // timestamp is at the true start of every printed line.
      const prefixed = format(...args)
        .split("\n")
        .map((line) => `${ts} ${line}`)
        .join("\n");
      original(prefixed);
    };
  }
}
