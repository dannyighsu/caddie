/**
 * Tests for reply-check (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/reply-check.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { countAssistantTurns, needsReplyNudge, mergeUsage } from "./reply-check.ts";

// --- countAssistantTurns ---

test("countAssistantTurns counts only assistant turns", () => {
  assert.equal(countAssistantTurns([]), 0);
  assert.equal(
    countAssistantTurns([
      { role: "user" },
      { role: "assistant" },
      { role: "user" },
      { role: "assistant" },
    ]),
    2,
  );
});

// --- needsReplyNudge ---

const silentRun = {
  deliveryMode: "tool" as const,
  success: true,
  sessionId: "s1",
  repliesBefore: 3,
  repliesAfter: 3,
};

test("needsReplyNudge fires for a successful tool-mode run that delivered nothing", () => {
  assert.equal(needsReplyNudge(silentRun), true);
});

test("needsReplyNudge does not fire once a reply was delivered", () => {
  assert.equal(needsReplyNudge({ ...silentRun, repliesAfter: 4 }), false);
});

test("needsReplyNudge ignores auto-delivery runs (final text is the reply)", () => {
  assert.equal(needsReplyNudge({ ...silentRun, deliveryMode: "auto" }), false);
});

test("needsReplyNudge ignores failed runs (the error path notifies the sender)", () => {
  assert.equal(needsReplyNudge({ ...silentRun, success: false }), false);
});

test("needsReplyNudge needs a session to resume", () => {
  assert.equal(needsReplyNudge({ ...silentRun, sessionId: "" }), false);
});

// --- mergeUsage ---

test("mergeUsage sums numeric fields and keeps the rest", () => {
  assert.deepEqual(
    mergeUsage(
      { input_tokens: 10, output_tokens: 5, service_tier: "standard" },
      { input_tokens: 2, cache_read_input_tokens: 7, service_tier: "priority" },
    ),
    { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 7, service_tier: "standard" },
  );
});

test("mergeUsage passes through when one side is missing", () => {
  assert.deepEqual(mergeUsage(undefined, { input_tokens: 1 }), { input_tokens: 1 });
  assert.deepEqual(mergeUsage({ input_tokens: 1 }, undefined), { input_tokens: 1 });
  assert.equal(mergeUsage(undefined, undefined), undefined);
});
