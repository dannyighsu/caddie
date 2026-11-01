/**
 * Tests for which inbound Slack message events reach the agent (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/slack-inbound.test.ts
 * (also wired as `pnpm test` in package.json)
 *
 * The event bodies follow Slack's documented `message.im` / `message.mpim`
 * payloads. The socket listener itself is thin glue and isn't covered here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createMessageClaims,
  decideDirectMessage,
  type SlackMessageEvent,
} from "./slack-inbound.ts";

const BOT = "UBOT123";

const im = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent => ({
  channel_type: "im",
  channel: "D024BE91L",
  user: "U2147483697",
  text: "hello",
  ts: "1355517523.000005",
  ...over,
});

const mpim = (over: Partial<SlackMessageEvent> = {}): SlackMessageEvent =>
  im({ channel_type: "mpim", channel: "G024BE91L", ...over });

test("a 1:1 DM is answered without a mention", () => {
  assert.deepEqual(decideDirectMessage(im(), BOT), {
    action: "handle",
    text: "hello",
    files: [],
  });
});

test("a group DM that mentions the bot is answered, without the mention in the text", () => {
  const decision = decideDirectMessage(mpim({ text: `<@${BOT}> what's on today?` }), BOT);
  assert.deepEqual(decision, { action: "handle", text: "what's on today?", files: [] });
});

test("the labelled mention form counts as a mention", () => {
  const decision = decideDirectMessage(mpim({ text: `<@${BOT}|ignis> hi` }), BOT);
  assert.deepEqual(decision, { action: "handle", text: "hi", files: [] });
});

test("a group DM without a mention is ignored", () => {
  assert.equal(decideDirectMessage(mpim({ text: "hello all" }), BOT).action, "skip");
});

test("a group DM mentioning only someone else is ignored", () => {
  assert.equal(decideDirectMessage(mpim({ text: "<@U999> hello" }), BOT).action, "skip");
});

test("a thread reply in a group DM still needs a mention", () => {
  const reply = mpim({ text: "and another thing", thread_ts: "1355517523.000005" });
  assert.equal(decideDirectMessage(reply, BOT).action, "skip");
});

test("the same event decided twice gives the same answer", () => {
  // The mention regex is global; a stateful test against it would flip here.
  const event = mpim({ text: `<@${BOT}> hi` });
  assert.equal(decideDirectMessage(event, BOT).action, "handle");
  assert.equal(decideDirectMessage(event, BOT).action, "handle");
});

test("other people named in a message stay in the text", () => {
  const decision = decideDirectMessage(mpim({ text: `<@${BOT}> ping <@U999> please` }), BOT);
  assert.deepEqual(decision, { action: "handle", text: "ping <@U999> please", files: [] });
});

test("the bot's own replies are ignored, so a reply can't trigger a run", () => {
  assert.equal(decideDirectMessage(im({ bot_id: "B123" }), BOT).action, "skip");
  assert.equal(decideDirectMessage(im({ user: BOT }), BOT).action, "skip");
});

test("another app's messages are ignored", () => {
  const event = im({ bot_id: "B456", subtype: "bot_message", user: undefined });
  assert.equal(decideDirectMessage(event, BOT).action, "skip");
});

test("housekeeping subtypes are ignored", () => {
  for (const subtype of ["message_changed", "message_deleted", "channel_join"]) {
    assert.equal(decideDirectMessage(im({ subtype }), BOT).action, "skip", subtype);
  }
});

test("a file upload is answered, with or without words", () => {
  const files = [{ name: "a.png" }];
  assert.deepEqual(
    decideDirectMessage(im({ subtype: "file_share", text: "", files }), BOT),
    { action: "handle", text: "", files },
  );
  // A bare mention with a screenshot in a group DM.
  assert.deepEqual(
    decideDirectMessage(mpim({ subtype: "file_share", text: `<@${BOT}>`, files }), BOT),
    { action: "handle", text: "", files },
  );
});

test("an empty message is ignored", () => {
  assert.equal(decideDirectMessage(im({ text: "" }), BOT).action, "skip");
  assert.equal(decideDirectMessage(mpim({ text: `<@${BOT}>` }), BOT).action, "skip");
});

test("messages outside DMs are ignored", () => {
  for (const channel_type of ["channel", "group", undefined]) {
    assert.equal(decideDirectMessage(im({ channel_type }), BOT).action, "skip");
  }
});

test("a message can be claimed only once", () => {
  const claim = createMessageClaims();
  assert.equal(claim("G1", "1.0"), true);
  assert.equal(claim("G1", "1.0"), false);
  assert.equal(claim("G1", "2.0"), true);
  assert.equal(claim("G2", "1.0"), true);
});

test("claims are bounded, dropping the oldest", () => {
  const claim = createMessageClaims(2);
  claim("G1", "1.0");
  claim("G1", "2.0");
  claim("G1", "3.0");
  assert.equal(claim("G1", "3.0"), false);
  assert.equal(claim("G1", "1.0"), true);
});
