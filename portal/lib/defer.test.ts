/**
 * Tests for the deferral window used when a recurring occurrence can't acquire
 * the active-run lock (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/defer.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeDeferral, DEFAULT_DEFER_MS } from "./defer.ts";

const NOW = Date.parse("2026-10-07T16:00:00Z");
const MIN = 60 * 1000;

test("defers by the default delay when there is runway", () => {
  const d = computeDeferral({ now: NOW, naturalNext: NOW + 60 * MIN });
  assert.deepEqual(d, {
    nextRun: NOW + DEFAULT_DEFER_MS,
    deadline: NOW + 60 * MIN,
  });
});

test("never defers past the next natural occurrence", () => {
  // Cron fires again in 30s — less than the retry delay.
  const d = computeDeferral({ now: NOW, naturalNext: NOW + 30_000 });
  assert.equal(d?.nextRun, NOW + 30_000);
  assert.equal(d?.deadline, NOW + 30_000);
});

test("a carried deadline, not the current nextRun, caps repeated deferrals", () => {
  const deadline = NOW + 5 * MIN;
  // Third deferral of the same occurrence: nextRun is already a deferred time,
  // so only the carried deadline keeps it from walking past the natural fire.
  const d = computeDeferral({ now: NOW + 4 * MIN, naturalNext: NOW + 4 * MIN + DEFAULT_DEFER_MS, deadline });
  assert.equal(d?.nextRun, deadline);
  assert.equal(d?.deadline, deadline);
});

test("does not defer once the deadline is reached", () => {
  assert.equal(computeDeferral({ now: NOW, naturalNext: NOW }), null);
  assert.equal(computeDeferral({ now: NOW, naturalNext: NOW - MIN }), null);
  assert.equal(
    computeDeferral({ now: NOW, naturalNext: NOW + 60 * MIN, deadline: NOW - MIN }),
    null
  );
});

test("honors an explicit delay", () => {
  const d = computeDeferral({ now: NOW, naturalNext: NOW + 60 * MIN, delayMs: 15_000 });
  assert.equal(d?.nextRun, NOW + 15_000);
});

test("no deferral when the deadline isn't a usable time", () => {
  assert.equal(computeDeferral({ now: NOW, naturalNext: NaN }), null);
});
