/**
 * Tests for conversation-history (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/conversation-history.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { renderHistoryLines } from "./conversation-history.ts";
import type { Message } from "./db.ts";

function msg(role: "user" | "assistant", content: string): Message {
  return { role, content, timestamp: new Date().toISOString() };
}

test("renderHistoryLines keeps turns in chronological order", () => {
  const lines = renderHistoryLines([
    msg("user", "what type of event is it?"),
    msg("assistant", "a wedding"),
  ]);

  assert.equal(lines.length, 2);
  assert.match(lines[0], /what type of event/);
  assert.match(lines[1], /a wedding/);
});

test("renderHistoryLines does not truncate a long message that fits the budget", () => {
  // The old flat 1000-char cap beheaded exactly this: a long, detail-heavy
  // reply whose substance sits past the opening paragraph.
  const detail = "pricing tier ".repeat(500); // ~6.5k chars
  const lines = renderHistoryLines([msg("user", detail)]);

  assert.equal(lines.length, 1);
  assert.ok(lines[0].includes(detail), "full message survives into the prompt");
  assert.ok(!lines[0].includes("truncated"));
});

test("renderHistoryLines spends the budget newest-first", () => {
  const filler = "x".repeat(40_000);
  const lines = renderHistoryLines([
    msg("user", filler),
    msg("assistant", filler),
    msg("user", "the latest thing they asked"),
  ]);

  // Newest turn is intact; the oldest gives way once the budget is gone.
  assert.match(lines[lines.length - 1], /the latest thing they asked$/);
  assert.ok(!lines[lines.length - 1].includes("truncated"));
  assert.ok(lines.length < 3 || lines[0].includes("truncated"));
});

test("renderHistoryLines marks a message it had to cut", () => {
  const lines = renderHistoryLines([
    msg("user", "y".repeat(80_000)),
    msg("assistant", "ok"),
  ]);

  assert.match(lines[0], /truncated — \d+ more characters/);
});

test("renderHistoryLines labels each turn by speaker", () => {
  const lines = renderHistoryLines([msg("assistant", "hi"), msg("user", "hello")]);

  assert.match(lines[0], /^\[Assistant\]: /);
  assert.match(lines[1], /^\[User\]: /);
});
