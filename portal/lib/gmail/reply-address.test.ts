/**
 * Tests for reply addressing (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/gmail/reply-address.test.ts
 * (also wired as `pnpm test` in package.json)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { selectReplyAnchor, buildReplyContext } from "./reply-address.ts";

const SELF = "agent@example.com";

const msg = (id: string) => ({ id });

test("selectReplyAnchor picks the named message, not the thread's last", () => {
  const thread = [msg("m1"), msg("m2"), msg("m3")];
  assert.equal(selectReplyAnchor(thread, "m2")?.id, "m2");
});

test("selectReplyAnchor falls back to the last message without an anchor", () => {
  const thread = [msg("m1"), msg("m2")];
  assert.equal(selectReplyAnchor(thread, undefined)?.id, "m2");
});

test("selectReplyAnchor falls back when the anchor is not in the thread", () => {
  const thread = [msg("m1"), msg("m2")];
  assert.equal(selectReplyAnchor(thread, "gone")?.id, "m2");
});

test("selectReplyAnchor returns undefined for an empty thread", () => {
  assert.equal(selectReplyAnchor([], "m1"), undefined);
});

test("a 1:1 message from a team member is answered to that team member", () => {
  // The regression: a team member replies privately into a thread that also
  // has a vendor on it, and the agent has just emailed the vendor. Anchoring
  // on the team member's own headers keeps the answer internal.
  const ctx = buildReplyContext({
    anchorHeaders: {
      From: "Betty Hu <betty@example.com>",
      To: "Buri H <agent@example.com>",
      "Message-ID": "<betty-1@mail>",
    },
    threadSubject: "Wedding site tour",
    selfEmail: SELF,
    replyAll: true,
  });
  assert.equal(ctx.to, "Betty Hu <betty@example.com>");
  assert.equal(ctx.cc, undefined);
  assert.equal(ctx.subject, "Re: Wedding site tour");
  assert.equal(ctx.inReplyTo, "<betty-1@mail>");
});

test("reply-all rebuilds To+Cc from the anchor, minus self", () => {
  const ctx = buildReplyContext({
    anchorHeaders: {
      From: "Vendor <vendor@example.com>",
      To: "agent@example.com, Danny <danny@example.com>",
      Cc: "Betty <betty@example.com>",
      "Message-ID": "<v-1@mail>",
      References: "<root@mail>",
    },
    threadSubject: "Re: Wedding site tour",
    selfEmail: SELF,
    replyAll: true,
  });
  assert.equal(ctx.to, "Vendor <vendor@example.com>");
  assert.equal(ctx.cc, "Danny <danny@example.com>, Betty <betty@example.com>");
  assert.equal(ctx.subject, "Re: Wedding site tour");
  assert.equal(ctx.references, "<root@mail> <v-1@mail>");
});

test("a plain reply drops the other recipients", () => {
  const ctx = buildReplyContext({
    anchorHeaders: {
      From: "Vendor <vendor@example.com>",
      To: "agent@example.com, Danny <danny@example.com>",
      "Message-ID": "<v-1@mail>",
    },
    selfEmail: SELF,
    replyAll: false,
  });
  assert.equal(ctx.to, "Vendor <vendor@example.com>");
  assert.equal(ctx.cc, undefined);
  assert.equal(ctx.subject, undefined);
});

test("an anchor we sent ourselves is answered to its recipients", () => {
  const ctx = buildReplyContext({
    anchorHeaders: {
      From: "Buri H <agent@example.com>",
      To: "Vendor <vendor@example.com>",
      Cc: "Danny <danny@example.com>",
      "Message-ID": "<self-1@mail>",
    },
    selfEmail: SELF,
    replyAll: true,
  });
  assert.equal(ctx.to, "Vendor <vendor@example.com>");
  assert.equal(ctx.cc, "Danny <danny@example.com>");
});

test("self is matched case-insensitively", () => {
  const ctx = buildReplyContext({
    anchorHeaders: {
      From: "Vendor <vendor@example.com>",
      To: "AGENT@Example.com, Danny <danny@example.com>",
      "Message-ID": "<v-1@mail>",
    },
    selfEmail: SELF,
    replyAll: true,
  });
  assert.equal(ctx.cc, "Danny <danny@example.com>");
});
