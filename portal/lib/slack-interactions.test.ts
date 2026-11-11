/**
 * Tests for reading a Slack form response out of an interaction (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/slack-interactions.test.ts
 * (also wired as `pnpm test` in package.json)
 *
 * The payloads follow Slack's documented `block_actions` shape. The socket
 * listener and the route are thin glue and aren't covered here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  closeForm,
  decideInteraction,
  parseInteractionBody,
  verifySlackSignature,
  type SlackInteractionPayload,
} from "./slack-interactions.ts";

const form = (overrides: Partial<SlackInteractionPayload> = {}): SlackInteractionPayload => ({
  type: "block_actions",
  user: { id: "U1" },
  channel: { id: "C1" },
  message: {
    ts: "100.1",
    text: "Trip form",
    blocks: [
      { type: "section", block_id: "intro", text: { type: "mrkdwn", text: "Plan the trip" } },
      { type: "input", block_id: "dest", label: { type: "plain_text", text: "Destination" } },
      { type: "input", block_id: "pace", label: { type: "plain_text", text: "Pace" } },
      { type: "actions", block_id: "go" },
    ],
  },
  actions: [
    {
      type: "button",
      action_id: "submit",
      block_id: "go",
      text: { text: "Submit" },
      value: "trip-1",
    },
  ],
  state: {
    values: {
      dest: { dest_input: { type: "plain_text_input", value: "Lisbon" } },
      pace: {
        pace_select: {
          type: "static_select",
          selected_option: { text: { text: "Slow" }, value: "slow" },
        },
      },
    },
  },
  ...overrides,
});

test("a submit renders the button and each field under its label", () => {
  const decision = decideInteraction(form());
  assert.equal(decision.action, "handle");
  if (decision.action !== "handle") return;
  assert.equal(
    decision.text,
    [
      "[Slack form response]",
      "Clicked: Submit (action_id: submit, value: trip-1)",
      "Destination: Lisbon",
      "Pace: Slow (slow)",
    ].join("\n"),
  );
  assert.equal(decision.channel, "C1");
  assert.equal(decision.ts, "100.1");
  assert.equal(decision.user, "U1");
  assert.equal(decision.fallbackText, "Trip form");
});

test("a form in a thread keeps its thread root, so it lands in that conversation", () => {
  const base = form();
  const decision = decideInteraction(
    form({ message: { ...base.message, thread_ts: "99.9" } }),
  );
  assert.equal(decision.action, "handle");
  if (decision.action === "handle") assert.equal(decision.threadTs, "99.9");
});

test("an empty field says so rather than vanishing", () => {
  const decision = decideInteraction(
    form({ state: { values: { dest: { dest_input: { type: "plain_text_input", value: null } } } } }),
  );
  assert.equal(decision.action, "handle");
  if (decision.action === "handle") assert.match(decision.text, /^Destination: \(blank\)$/m);
});

test("every element type renders its value", () => {
  const decision = decideInteraction(
    form({
      state: {
        values: {
          a: { people: { selected_users: ["U2", "U3"] } },
          b: { room: { selected_channel: "C9" } },
          c: { day: { selected_date: "2026-11-02" } },
          d: { at: { selected_date_time: 0 } },
          e: {
            tags: {
              selected_options: [
                { text: { text: "One" }, value: "One" },
                { text: { text: "Two" }, value: "2" },
              ],
            },
          },
          f: {
            notes: {
              rich_text_value: {
                elements: [{ elements: [{ elements: [{ text: "hello " }, { text: "there" }] }] }],
              },
            },
          },
        },
      },
    }),
  );
  assert.equal(decision.action, "handle");
  if (decision.action !== "handle") return;
  assert.match(decision.text, /^people: <@U2>, <@U3>$/m);
  assert.match(decision.text, /^room: <#C9>$/m);
  assert.match(decision.text, /^day: 2026-11-02$/m);
  assert.match(decision.text, /^tags: One, Two \(2\)$/m);
  assert.match(decision.text, /^notes: hello there$/m);
});

test("a select that fires on its own isn't repeated as a field", () => {
  const select = {
    type: "static_select",
    action_id: "pick",
    block_id: "b",
    selected_option: { text: { text: "Yes" }, value: "yes" },
  };
  const decision = decideInteraction(
    form({ actions: [select], state: { values: { b: { pick: select } } } }),
  );
  assert.equal(decision.action, "handle");
  if (decision.action !== "handle") return;
  assert.equal(
    decision.text,
    "[Slack form response]\nChose: Yes (yes) (action_id: pick)",
  );
});

test("what isn't a response on a message is skipped", () => {
  const skipped = (payload: SlackInteractionPayload) =>
    decideInteraction(payload).action === "skip";
  assert.ok(skipped(form({ type: "view_submission" })));
  assert.ok(skipped(form({ user: undefined })));
  assert.ok(skipped(form({ message: undefined })));
  assert.ok(skipped(form({ channel: undefined })));
  assert.ok(skipped(form({ actions: [] })));
});

test("a link button answers nothing", () => {
  const decision = decideInteraction(
    form({ actions: [{ type: "button", action_id: "open", url: "https://example.com" }] }),
  );
  assert.equal(decision.action, "skip");
});

test("closing a form drops every control and names who answered", () => {
  const closed = closeForm(
    [
      { type: "section", text: { type: "mrkdwn", text: "Kept" } },
      { type: "section", text: { type: "mrkdwn", text: "Button" }, accessory: { type: "button" } },
      { type: "section", text: { type: "mrkdwn", text: "Photo" }, accessory: { type: "image" } },
      { type: "input" },
      { type: "actions" },
    ],
    "U1",
  );
  assert.equal(closed.length, 4);
  assert.equal(closed[1].accessory, undefined);
  assert.deepEqual(closed[2].accessory, { type: "image" });
  assert.deepEqual(closed[3], {
    type: "context",
    elements: [{ type: "mrkdwn", text: "Submitted by <@U1>" }],
  });
});

test("closing a full message stays within Slack's block limit", () => {
  const blocks = Array.from({ length: 50 }, () => ({
    type: "section",
    accessory: { type: "button" },
  }));
  assert.equal(closeForm(blocks, "U1").length, 50);
});

test("the interaction body is form-encoded JSON", () => {
  const body = new URLSearchParams({ payload: JSON.stringify({ type: "block_actions" }) });
  assert.deepEqual(parseInteractionBody(body.toString()), { type: "block_actions" });
  assert.equal(parseInteractionBody("payload=%7Bnope"), null);
  assert.equal(parseInteractionBody("other=1"), null);
});

const SECRET = "shh";
const sign = (timestamp: string, rawBody: string, secret = SECRET) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");

test("a signature made with the signing secret verifies", () => {
  assert.ok(
    verifySlackSignature({
      secret: SECRET,
      timestamp: "1000",
      signature: sign("1000", "body"),
      rawBody: "body",
      nowSeconds: 1000,
    }),
  );
});

test("a forged, altered, stale or missing signature doesn't", () => {
  const check = (signature: string | null, timestamp: string | null, rawBody = "body") =>
    verifySlackSignature({ secret: SECRET, timestamp, signature, rawBody, nowSeconds: 1000 });
  assert.equal(check(sign("1000", "body", "wrong"), "1000"), false);
  assert.equal(check(sign("1000", "body"), "1000", "tampered"), false);
  assert.equal(check(sign("1", "body"), "1"), false);
  assert.equal(check("v0=short", "1000"), false);
  assert.equal(check(null, "1000"), false);
  assert.equal(check(sign("1000", "body"), null), false);
});
