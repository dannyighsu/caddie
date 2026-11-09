/**
 * Tests for job failure streaks — the throttle and the message text that decide
 * whether a broken scheduled job is audible without being a firehose.
 *
 * Run: node --test --experimental-strip-types lib/job-failure-streak.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  failureSignature,
  recordFailure,
  markNotified,
  formatFailureAlert,
  formatRecoveryAlert,
  formatFallbackEmail,
  RE_ALERT_MS,
  type FailureStreak,
} from "./job-failure-streak.ts";

const T0 = Date.UTC(2026, 10, 4, 16, 0, 0); // 2026-11-04 08:00 PT
const ERR = "Command exited 1: `poll.py`\n```ERROR: GRANOLA_API_KEY environment variable not set```";

/** A streak as it would be carried after one delivered alert. */
function alertedStreak(overrides: Partial<FailureStreak> = {}): FailureStreak {
  const first = recordFailure(null, ERR, T0);
  return { ...markNotified(first.streak, T0), ...overrides };
}

// --- signature ---

test("the signature ignores timestamps and numbers so repeats collapse", () => {
  const a = "Command timed out after 120000ms at 2026-11-04T16:00:00Z (pid 4812)";
  const b = "Command timed out after 120000ms at 2026-11-04T16:05:00Z (pid 5133)";
  assert.equal(failureSignature(a), failureSignature(b));
});

test("the signature still separates genuinely different errors", () => {
  assert.notEqual(
    failureSignature("Command exited 1: GRANOLA_API_KEY not set"),
    failureSignature("Command failed to start: ENOENT")
  );
});

// --- throttle ---

test("the first failure always alerts", () => {
  const d = recordFailure(null, ERR, T0);
  assert.equal(d.notify, true);
  assert.equal(d.reason, "first");
  assert.equal(d.streak.count, 1);
  assert.equal(d.streak.lastNotifiedAt, null);
  assert.equal(d.streak.notifiedCount, 0);
});

test("an identical repeat inside the quiet period is suppressed but counted", () => {
  const prev = alertedStreak();
  const d = recordFailure(prev, ERR, T0 + 5 * 60_000);
  assert.equal(d.notify, false);
  assert.equal(d.reason, "suppressed");
  assert.equal(d.streak.count, 2);
  // The delivered-at stamp is carried, not refreshed, so the quiet period is
  // measured from the last alert rather than sliding on every failure.
  assert.equal(d.streak.lastNotifiedAt, T0);
});

test("a workday of five-minute failures produces one alert", () => {
  let streak = recordFailure(null, ERR, T0).streak;
  streak = markNotified(streak, T0);
  let alerts = 1;
  for (let i = 1; i <= 130; i++) {
    const at = T0 + i * 5 * 60_000; // ~11 hours of ticks
    const d = recordFailure(streak, ERR, at);
    streak = d.notify ? markNotified(d.streak, at) : d.streak;
    if (d.notify) alerts++;
  }
  assert.equal(streak.count, 131);
  // One opening alert plus the 6-hourly reminders over ~10.8h.
  assert.equal(alerts, 2);
});

test("the quiet period elapsing produces a reminder", () => {
  const prev = alertedStreak();
  const d = recordFailure(prev, ERR, T0 + RE_ALERT_MS);
  assert.equal(d.notify, true);
  assert.equal(d.reason, "reminder");
});

test("a changed error alerts immediately and restarts the streak", () => {
  const prev = alertedStreak({ count: 40 });
  const d = recordFailure(prev, "Command failed to start: ENOENT", T0 + 60_000);
  assert.equal(d.notify, true);
  assert.equal(d.reason, "changed");
  assert.equal(d.streak.count, 1);
  assert.equal(d.streak.notifiedCount, 0);
});

test("an undelivered alert is retried on the next failure rather than waiting", () => {
  // recordFailure left lastNotifiedAt null because no channel took the message.
  const prev = recordFailure(null, ERR, T0).streak;
  const d = recordFailure(prev, ERR, T0 + 5 * 60_000);
  assert.equal(d.notify, true);
  assert.equal(d.streak.count, 2);
});

test("markNotified stamps the delivery and counts it", () => {
  const streak = markNotified(recordFailure(null, ERR, T0).streak, T0 + 10);
  assert.equal(streak.lastNotifiedAt, T0 + 10);
  assert.equal(streak.notifiedCount, 1);
});

// --- message text ---

test("a first alert quotes the error and says nothing about a streak", () => {
  const msg = formatFailureAlert("post-call-followup", recordFailure(null, ERR, T0));
  assert.match(msg, /Scheduled job failed:\* post-call-followup/);
  assert.match(msg, /GRANOLA_API_KEY environment variable not set/);
  assert.doesNotMatch(msg, /consecutive/);
});

test("a reminder says how long and how often", () => {
  const prev = alertedStreak();
  const d = recordFailure({ ...prev, count: 72 }, ERR, T0 + RE_ALERT_MS);
  const msg = formatFailureAlert("post-call-followup", d);
  assert.match(msg, /73 consecutive failures since/);
  assert.match(msg, /6h 0m/);
});

test("a changed error is labeled as new rather than a repeat", () => {
  const d = recordFailure(alertedStreak(), "Command failed to start: ENOENT", T0 + 60_000);
  assert.match(formatFailureAlert("job", d).split("\n")[0], /new error/);
});

test("the error quote is capped", () => {
  const d = recordFailure(null, "x".repeat(5000), T0);
  assert.ok(formatFailureAlert("job", d).length < 1200);
});

test("recovery names the streak it closes", () => {
  const streak = { ...alertedStreak(), count: 131, lastAt: T0 + 11 * 60 * 60_000 };
  const msg = formatRecoveryAlert("post-call-followup", streak);
  assert.match(msg, /recovered/);
  assert.match(msg, /131 consecutive failures/);
  assert.match(msg, /11h 0m/);
});

test("the fallback email explains why it isn't in chat", () => {
  const body = formatFallbackEmail(
    "post-call-followup",
    ":warning: *Scheduled job failed:* post-call-followup",
    "slack",
    "No Slack channel specified and no default configured"
  );
  assert.match(body, /could not take it/);
  assert.match(body, /No Slack channel specified and no default configured/);
  assert.match(body, /notificationRecipient/);
  // Slack markup is stripped — this is an email.
  assert.doesNotMatch(body, /\*Scheduled/);
});
