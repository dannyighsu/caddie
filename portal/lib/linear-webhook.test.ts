/**
 * Tests for linear-webhook (pure logic): the signature and freshness checks,
 * and reading the sender, message and context out of an agent session event.
 *
 * Run: node --test --experimental-strip-types lib/linear-webhook.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import {
  MAX_WEBHOOK_SKEW_MS,
  inboundTextOf,
  isAgentSessionEvent,
  isFresh,
  isStopSignal,
  promptContextOf,
  senderOf,
  verifySignature,
  type AgentSessionEvent,
} from "./linear-webhook.ts";

const SECRET = "whsec";
const sign = (body: string, secret = SECRET) => createHmac("sha256", secret).update(body).digest("hex");

const CREATOR = { id: "u1", name: "Ada", email: "ada@example.com" };
const PROMPTER = { id: "u2", name: "Grace", email: "grace@example.com" };

function created(overrides: Partial<AgentSessionEvent["agentSession"]> = {}): AgentSessionEvent {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org",
    appUserId: "app",
    webhookTimestamp: 0,
    promptContext: '<issue identifier="ENG-1"><title>Fix it</title></issue>',
    agentSession: {
      id: "sess",
      creator: CREATOR,
      comment: { id: "c1", body: "@caddie please fix this" },
      issue: { id: "i1", identifier: "ENG-1", title: "Fix it", url: "https://linear.app/acme/issue/ENG-1" },
      ...overrides,
    },
  };
}

function prompted(body: string, signal: string | null = null): AgentSessionEvent {
  return {
    ...created(),
    action: "prompted",
    promptContext: null,
    agentActivity: { id: "a1", content: { type: "prompt", body }, signal, user: PROMPTER },
  };
}

test("a signature over the raw body verifies", () => {
  const body = '{"type":"AgentSessionEvent"}';
  assert.equal(verifySignature(body, sign(body), SECRET), true);
});

test("a signature from another secret, another body, or none fails", () => {
  const body = '{"type":"AgentSessionEvent"}';
  assert.equal(verifySignature(body, sign(body, "other"), SECRET), false);
  assert.equal(verifySignature(body + " ", sign(body), SECRET), false);
  assert.equal(verifySignature(body, null, SECRET), false);
  assert.equal(verifySignature(body, "zz-not-hex", SECRET), false);
  assert.equal(verifySignature(body, sign(body).slice(0, 10), SECRET), false);
});

test("a delivery is fresh only within the skew window", () => {
  const now = 1_700_000_000_000;
  assert.equal(isFresh(now - 1_000, now), true);
  assert.equal(isFresh(now - MAX_WEBHOOK_SKEW_MS - 1, now), false);
  assert.equal(isFresh(now + MAX_WEBHOOK_SKEW_MS + 1, now), false);
  assert.equal(isFresh(undefined, now), false);
  assert.equal(isFresh(String(now), now), false);
});

test("only agent session events with a session are recognized", () => {
  assert.equal(isAgentSessionEvent(created()), true);
  assert.equal(isAgentSessionEvent({ type: "Issue", action: "create" }), false);
  assert.equal(isAgentSessionEvent({ type: "AgentSessionEvent" }), false);
  assert.equal(isAgentSessionEvent(null), false);
});

test("the sender is the session's creator on created, the prompter on prompted", () => {
  assert.equal(senderOf(created())?.email, "ada@example.com");
  assert.equal(senderOf(prompted("more"))?.email, "grace@example.com");
});

test("the message is the mention comment, the follow-up, or the delegated issue", () => {
  assert.equal(inboundTextOf(created()), "@caddie please fix this");
  assert.equal(inboundTextOf(prompted("  also the footer  ")), "also the footer");
  assert.equal(inboundTextOf(created({ comment: null })), "Delegated ENG-1 to you: Fix it");
});

test("stop is a prompted event with the stop signal", () => {
  assert.equal(isStopSignal(prompted("", "stop")), true);
  assert.equal(isStopSignal(prompted("keep going")), false);
  assert.equal(isStopSignal(created()), false);
});

test("the context names the issue and carries Linear's context when sent", () => {
  const ctx = promptContextOf(created());
  assert.match(ctx, /Issue: ENG-1 Fix it/);
  assert.match(ctx, /https:\/\/linear\.app\/acme\/issue\/ENG-1/);
  assert.match(ctx, /<issue identifier="ENG-1">/);
  assert.match(ctx, /`linear` skill/);
  assert.doesNotMatch(promptContextOf(prompted("x")), /Linear's context/);
});
