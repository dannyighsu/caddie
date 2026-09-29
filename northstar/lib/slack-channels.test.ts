/**
 * Tests for slack-channels (pure logic — no Slack SDK, no network).
 *
 * Run: node --test --experimental-strip-types lib/slack-channels.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  collectChannels,
  toChannelSummary,
  MAX_PAGES,
  type ConversationsListPage,
  type RawSlackChannel,
} from "./slack-channels.ts";

const raw = (over: RawSlackChannel = {}): RawSlackChannel => ({
  id: "C1",
  name: "general",
  is_private: false,
  is_member: true,
  is_archived: false,
  ...over,
});

/** A fetcher over fixed pages that asserts the cursor is threaded through. */
function pager(pages: ConversationsListPage[]) {
  const seen: (string | undefined)[] = [];
  const fetchPage = async (cursor?: string) => {
    seen.push(cursor);
    return pages[seen.length - 1] ?? { channels: [] };
  };
  return { fetchPage, seen };
}

// --- toChannelSummary ---

test("toChannelSummary maps the fields the agent needs", () => {
  assert.deepEqual(
    toChannelSummary(
      raw({
        id: "C42",
        name: "eng",
        is_private: true,
        is_member: false,
        num_members: 7,
        topic: { value: "ship it" },
        purpose: { value: "" },
      }),
    ),
    {
      id: "C42",
      name: "eng",
      isPrivate: true,
      isMember: false,
      isArchived: false,
      numMembers: 7,
      topic: "ship it",
    },
  );
});

test("toChannelSummary drops channels with no id or no name", () => {
  assert.equal(toChannelSummary({ name: "nameless-id" }), null);
  assert.equal(toChannelSummary({ id: "C1" }), null);
});

// --- collectChannels: pagination ---

test("collectChannels follows the cursor to the last page", async () => {
  const { fetchPage, seen } = pager([
    { channels: [raw({ id: "C1", name: "a" })], response_metadata: { next_cursor: "cur1" } },
    { channels: [raw({ id: "C2", name: "b" })], response_metadata: { next_cursor: "cur2" } },
    { channels: [raw({ id: "C3", name: "c" })], response_metadata: { next_cursor: "" } },
  ]);

  const { channels, truncated } = await collectChannels(fetchPage);

  assert.deepEqual(seen, [undefined, "cur1", "cur2"]);
  assert.deepEqual(
    channels.map((c) => c.id),
    ["C1", "C2", "C3"],
  );
  assert.equal(truncated, false);
});

test("collectChannels stops at MAX_PAGES and reports truncation", async () => {
  let calls = 0;
  const { channels, truncated } = await collectChannels(async () => {
    calls++;
    return {
      channels: [raw({ id: `C${calls}`, name: `c${calls}` })],
      // Never-ending cursor.
      response_metadata: { next_cursor: `cur${calls}` },
    };
  });

  assert.equal(calls, MAX_PAGES);
  assert.equal(channels.length, MAX_PAGES);
  assert.equal(truncated, true);
});

// --- collectChannels: filtering ---

test("collectChannels excludes archived channels unless asked", async () => {
  const pages: ConversationsListPage[] = [
    {
      channels: [
        raw({ id: "C1", name: "live" }),
        raw({ id: "C2", name: "old", is_archived: true }),
      ],
    },
  ];

  const without = await collectChannels(pager(pages).fetchPage);
  assert.deepEqual(
    without.channels.map((c) => c.id),
    ["C1"],
  );

  const withArchived = await collectChannels(pager(pages).fetchPage, {
    includeArchived: true,
  });
  assert.deepEqual(
    withArchived.channels.map((c) => c.id).sort(),
    ["C1", "C2"],
  );
});

test("collectChannels filters by case-insensitive name substring", async () => {
  const { fetchPage } = pager([
    {
      channels: [
        raw({ id: "C1", name: "Engineering" }),
        raw({ id: "C2", name: "design" }),
        raw({ id: "C3", name: "eng-oncall" }),
      ],
    },
  ]);

  const { channels } = await collectChannels(fetchPage, { nameFilter: " ENG " });

  assert.deepEqual(
    channels.map((c) => c.id).sort(),
    ["C1", "C3"],
  );
});

test("collectChannels caps at limit and flags truncation", async () => {
  const { fetchPage } = pager([
    {
      channels: [
        raw({ id: "C1", name: "a" }),
        raw({ id: "C2", name: "b" }),
        raw({ id: "C3", name: "c" }),
      ],
    },
  ]);

  const { channels, truncated } = await collectChannels(fetchPage, { limit: 2 });

  assert.equal(channels.length, 2);
  assert.equal(truncated, true);
});

test("collectChannels does not flag truncation when the last page exactly fills limit", async () => {
  const { fetchPage } = pager([
    { channels: [raw({ id: "C1", name: "a" }), raw({ id: "C2", name: "b" })] },
  ]);

  const { channels, truncated } = await collectChannels(fetchPage, { limit: 2 });

  assert.equal(channels.length, 2);
  assert.equal(truncated, false);
});

// --- collectChannels: ordering ---

test("collectChannels sorts postable channels first, then by name", async () => {
  const { fetchPage } = pager([
    {
      channels: [
        raw({ id: "C1", name: "zebra", is_member: true }),
        raw({ id: "C2", name: "alpha", is_member: false }),
        raw({ id: "C3", name: "beta", is_member: true }),
        raw({ id: "C4", name: "yak", is_member: false }),
      ],
    },
  ]);

  const { channels } = await collectChannels(fetchPage);

  assert.deepEqual(
    channels.map((c) => c.name),
    ["beta", "zebra", "alpha", "yak"],
  );
});

test("collectChannels tolerates a page with no channels array", async () => {
  const { channels, truncated } = await collectChannels(async () => ({}));
  assert.deepEqual(channels, []);
  assert.equal(truncated, false);
});
