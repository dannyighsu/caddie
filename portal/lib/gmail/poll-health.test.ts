/**
 * Tests for inbound poll health — the deadline wrapper, the stuck-poll rule and
 * the stall/throttle decisions that decide whether a dead inbound poller is
 * audible.
 *
 * The case that matters most is "a dispatch that never settles": that is the
 * shape of the 2026-11-20 outage, and before the deadline existed it stopped
 * inbound email for five days without throwing anything.
 *
 * Run: node --test --experimental-strip-types lib/gmail/poll-health.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withTimeout,
  TimeoutError,
  initialStatus,
  isPollStuck,
  detectStall,
  shouldAlert,
  formatStallAlert,
  describePollerHealth,
  errorSignature,
  NO_PROGRESS_MS,
  QUEUE_STALL_MS,
  RE_ALERT_MS,
  type PollerStatus,
} from "./poll-health.ts";

const T0 = Date.UTC(2026, 10, 20, 19, 14, 0); // the last good dispatch
const MIN = 60_000;

function status(overrides: Partial<PollerStatus> = {}): PollerStatus {
  return { ...initialStatus(true, T0), lastPollStartedAt: T0, lastProgressAt: T0, ...overrides };
}

// --- withTimeout ---

test("a promise that settles in time passes its value through", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000, "fetch"), 7);
});

test("a promise that never settles rejects, so the caller is freed", async () => {
  const never = new Promise<number>(() => {});
  await assert.rejects(
    () => withTimeout(never, 10, "dispatch abc123"),
    (err: unknown) => {
      assert.ok(err instanceof TimeoutError);
      assert.equal((err as TimeoutError).label, "dispatch abc123");
      assert.match((err as Error).message, /did not settle within 10ms/);
      return true;
    },
  );
});

test("a rejection is passed through unchanged rather than masked as a timeout", async () => {
  const boom = new Error("Redis unreachable");
  await assert.rejects(() => withTimeout(Promise.reject(boom), 1000, "claim"), /Redis unreachable/);
});

// --- isPollStuck ---

test("a poll making progress is not stuck", () => {
  const s = status({ lastProgressAt: T0 + 5 * MIN });
  assert.equal(isPollStuck(s, T0 + 6 * MIN), false);
});

test("a poll whose steps have all overrun their own deadlines is stuck", () => {
  // Every step is bounded, so no progress past the bound means something
  // escaped its deadline — exactly the condition that wedged the latch.
  const s = status();
  assert.equal(isPollStuck(s, T0 + NO_PROGRESS_MS + 1), true);
});

test("a slow but legitimate dispatch is not abandoned mid-run", () => {
  // NO_PROGRESS_MS must exceed the dispatch deadline, or a long agent run
  // would be abandoned while still working normally.
  const s = status();
  assert.equal(isPollStuck(s, T0 + 15 * MIN), false);
});

test("a poller that has never polled cannot be stuck", () => {
  const s = initialStatus(true, T0);
  assert.equal(isPollStuck(s, T0 + 10 * NO_PROGRESS_MS), false);
});

// --- detectStall ---

test("mail sitting unhandled past the stall window is reported", () => {
  const s = status({ queueDepth: 4, oldestQueuedAt: T0 });
  const stall = detectStall(s, T0 + QUEUE_STALL_MS + MIN);
  assert.ok(stall);
  assert.equal(stall.kind, "queue-backlog");
  assert.match(stall.detail, /4 unread message\(s\)/);
});

test("the five-day outage would have been caught on the first tick after it began", () => {
  const s = status({ queueDepth: 1, oldestQueuedAt: T0, lastDispatchAt: T0 });
  // Not yet: a message a few minutes old is just a message in flight.
  assert.equal(detectStall(s, T0 + 5 * MIN), null);
  // Within the hour, it is a stall — not five days later via a human asking.
  assert.ok(detectStall(s, T0 + 20 * MIN));
});

test("an empty queue is not a stall, however long since the last dispatch", () => {
  // A quiet mailbox is the normal case and must never alert.
  const s = status({ queueDepth: 0, lastDispatchAt: T0, lastPollCompletedAt: T0 + 5 * 24 * 60 * MIN });
  assert.equal(detectStall(s, T0 + 5 * 24 * 60 * MIN), null);
});

test("one failed poll is noise; three in a row is news", () => {
  const one = status({ consecutivePollErrors: 1, lastPollError: "ETIMEDOUT" });
  assert.equal(detectStall(one, T0), null);
  const three = status({ consecutivePollErrors: 3, lastPollError: "ETIMEDOUT" });
  const stall = detectStall(three, T0);
  assert.ok(stall);
  assert.equal(stall.kind, "poll-errors");
});

test("a disabled poller never alerts", () => {
  const s = { ...initialStatus(false, T0), queueDepth: 9, oldestQueuedAt: T0 };
  assert.equal(detectStall(s, T0 + 10 * QUEUE_STALL_MS), null);
});

// --- shouldAlert ---

const stall = { kind: "queue-backlog" as const, detail: "4 unread", signature: "queue-backlog" };

test("the first sighting of a problem alerts", () => {
  assert.equal(shouldAlert({}, stall, T0), true);
});

test("the same problem stays quiet until the re-alert window passes", () => {
  const state = { lastAlertAt: T0, lastSignature: "queue-backlog" };
  assert.equal(shouldAlert(state, stall, T0 + MIN), false);
  assert.equal(shouldAlert(state, stall, T0 + RE_ALERT_MS), true);
});

test("a different problem alerts immediately — different news", () => {
  const state = { lastAlertAt: T0, lastSignature: "poll-errors:ETIMEDOUT" };
  assert.equal(shouldAlert(state, stall, T0 + MIN), true);
});

// --- signatures ---

test("the signature ignores digits so repeats of one error collapse", () => {
  assert.equal(
    errorSignature("dispatch 18f2 did not settle within 900000ms at 19:14:02"),
    errorSignature("dispatch 18f2 did not settle within 900000ms at 20:15:41"),
  );
  assert.notEqual(errorSignature("Redis unreachable"), errorSignature("Gmail 403"));
});

// --- message text ---

test("the alert says mail is not lost, and that Slack still works", () => {
  const body = formatStallAlert("the agent", stall, status({ lastDispatchAt: T0, queueDepth: 4 }));
  assert.match(body, /still in the mailbox/);
  assert.match(body, /Slack is unaffected/);
  assert.match(body, /2026-11-20T19:14:00/); // last successful dispatch, so the gap is visible
});

test("health reports a stall as an error and a quiet mailbox as ok", () => {
  const stalled = describePollerHealth(
    status({ queueDepth: 2, oldestQueuedAt: T0 }),
    T0 + QUEUE_STALL_MS + MIN,
  );
  assert.equal(stalled.status, "error");

  const quiet = describePollerHealth(status({ queueDepth: 0, lastPollCompletedAt: T0 }), T0 + MIN);
  assert.equal(quiet.status, "ok");

  assert.equal(describePollerHealth(initialStatus(false, T0), T0).status, "skipped");
});
