/**
 * Tests for slack-blocks (pure logic — no Slack SDK, no network).
 *
 * Run: node --test --experimental-strip-types lib/slack-blocks.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeBlocks, withAttribution, MAX_BLOCKS } from "./slack-blocks.ts";

const header = { type: "header", text: { type: "plain_text", text: "Usage" } };

// --- normalizeBlocks ---

test("no payload means a plain text post", () => {
  assert.deepEqual(normalizeBlocks(undefined), {});
  assert.deepEqual(normalizeBlocks(null), {});
  assert.deepEqual(normalizeBlocks("   "), {});
});

test("accepts an array of blocks", () => {
  assert.deepEqual(normalizeBlocks([header]), { blocks: [header] });
});

test("accepts a JSON string, as job scripts produce", () => {
  assert.deepEqual(normalizeBlocks(JSON.stringify([header])), { blocks: [header] });
});

test("unwraps the {blocks:[...]} payload Block Kit Builder copies out", () => {
  assert.deepEqual(normalizeBlocks({ blocks: [header] }), { blocks: [header] });
  assert.deepEqual(normalizeBlocks(JSON.stringify({ text: "hi", blocks: [header] })), {
    blocks: [header],
  });
});

test("rejects malformed JSON with the parse error", () => {
  const { blocks, error } = normalizeBlocks("[{type:");
  assert.equal(blocks, undefined);
  assert.match(error ?? "", /not valid JSON/);
});

test("rejects a non-array payload", () => {
  assert.match(normalizeBlocks(42).error ?? "", /must be an array/);
  assert.match(normalizeBlocks({ type: "header" }).error ?? "", /must be an array/);
});

test("rejects an empty array rather than posting a blank message", () => {
  assert.match(normalizeBlocks([]).error ?? "", /empty/);
});

test("rejects more blocks than Slack accepts, naming both counts", () => {
  const tooMany = Array.from({ length: MAX_BLOCKS + 1 }, () => header);
  assert.match(normalizeBlocks(tooMany).error ?? "", /51 entries.*at most 50/);
  assert.deepEqual(normalizeBlocks(Array.from({ length: MAX_BLOCKS }, () => header)).error, undefined);
});

test("rejects entries that aren't blocks, pointing at the index", () => {
  assert.match(normalizeBlocks([header, "divider"]).error ?? "", /blocks\[1\] is not an object/);
  assert.match(normalizeBlocks([header, null]).error ?? "", /blocks\[1\] is not an object/);
  assert.match(normalizeBlocks([[header]]).error ?? "", /blocks\[0\] is not an object/);
  assert.match(normalizeBlocks([{ text: "hi" }]).error ?? "", /blocks\[0\] is missing a string "type"/);
  assert.match(normalizeBlocks([{ type: "" }]).error ?? "", /missing a string "type"/);
});

// --- withAttribution ---

test("attribution is prepended as a context block", () => {
  const out = withAttribution([header], "Buri");
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], {
    type: "context",
    elements: [{ type: "mrkdwn", text: "*[Buri]*" }],
  });
  assert.deepEqual(out[1], header);
});

test("no attribution leaves the layout untouched", () => {
  const blocks = [header];
  assert.equal(withAttribution(blocks, undefined), blocks);
  assert.equal(withAttribution(blocks, ""), blocks);
});

test("a full payload is posted as-is rather than failing on the block limit", () => {
  const full = Array.from({ length: MAX_BLOCKS }, () => header);
  assert.equal(withAttribution(full, "Buri").length, MAX_BLOCKS);
});
