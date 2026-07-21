/**
 * Tests for email-threading (pure logic).
 *
 * Run: node --test --experimental-strip-types lib/email-threading.test.ts
 * (also wired as `pnpm test` in package.json)
 *
 * Covers each exported function directly, then stress-tests selectInboundBody
 * against invariants across thousands of seeded-random inputs — the branching
 * here is subtle (four rules, priority order, empty fallbacks) and the failure
 * modes are silent (a wrong branch drops or duplicates history), so exhaustive
 * randomized coverage guards against regressions unit cases would miss.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeMessageId,
  parseMessageRefs,
  isForwardedMessage,
  selectInboundBody,
  type InboundBodyInput,
  type InboundBodyReason,
} from "./email-threading.ts";

// --- normalizeMessageId ---

test("normalizeMessageId strips brackets and whitespace", () => {
  assert.equal(normalizeMessageId("<a@b.com>"), "a@b.com");
  assert.equal(normalizeMessageId("  <a@b.com>  "), "a@b.com");
  assert.equal(normalizeMessageId("a@b.com"), "a@b.com");
  assert.equal(normalizeMessageId("<<a@b.com>>"), "a@b.com");
  assert.equal(normalizeMessageId(""), "");
  assert.equal(normalizeMessageId("<>"), "");
  // Case is significant per RFC 5322 — must be preserved.
  assert.equal(normalizeMessageId("<Abc@B.com>"), "Abc@B.com");
});

// --- parseMessageRefs ---

test("parseMessageRefs reads a single In-Reply-To", () => {
  const refs = parseMessageRefs({ "In-Reply-To": "<parent@x.com>" });
  assert.equal(refs.inReplyTo, "parent@x.com");
  assert.deepEqual(refs.references, []);
});

test("parseMessageRefs reads a multi-id References chain, oldest→newest", () => {
  const refs = parseMessageRefs({
    References: "<a@x.com>\r\n <b@x.com>\t<c@x.com>",
    "In-Reply-To": "<c@x.com>",
  });
  assert.deepEqual(refs.references, ["a@x.com", "b@x.com", "c@x.com"]);
  assert.equal(refs.inReplyTo, "c@x.com");
});

test("parseMessageRefs falls back to last References entry when In-Reply-To absent", () => {
  const refs = parseMessageRefs({ References: "<a@x.com> <b@x.com>" });
  assert.equal(refs.inReplyTo, "b@x.com");
});

test("parseMessageRefs header lookup is case-insensitive", () => {
  const refs = parseMessageRefs({ "in-reply-to": "<p@x.com>", REFERENCES: "<a@x.com>" });
  assert.equal(refs.inReplyTo, "p@x.com");
  assert.deepEqual(refs.references, ["a@x.com"]);
});

test("parseMessageRefs takes nearest ancestor when In-Reply-To is malformed with multiple ids", () => {
  const refs = parseMessageRefs({ "In-Reply-To": "<older@x.com> <nearest@x.com>" });
  assert.equal(refs.inReplyTo, "nearest@x.com");
});

test("parseMessageRefs handles unbracketed ids and empty headers", () => {
  assert.equal(parseMessageRefs({ "In-Reply-To": "bare@x.com" }).inReplyTo, "bare@x.com");
  const empty = parseMessageRefs({});
  assert.equal(empty.inReplyTo, undefined);
  assert.deepEqual(empty.references, []);
});

// --- isForwardedMessage ---

test("isForwardedMessage detects forward subject prefixes", () => {
  assert.ok(isForwardedMessage("Fwd: dinner plans", ""));
  assert.ok(isForwardedMessage("FW: dinner plans", ""));
  assert.ok(isForwardedMessage("Fw: dinner plans", ""));
  assert.ok(isForwardedMessage("fwd : spaced", ""));
});

test("isForwardedMessage detects forwarded-message banners in the body", () => {
  assert.ok(isForwardedMessage("dinner", "hey\n---------- Forwarded message ---------\nFrom: B"));
  assert.ok(isForwardedMessage("dinner", "Begin forwarded message:\nFrom: B"));
  // Nested forward: banner preceded by quote markers.
  assert.ok(isForwardedMessage("dinner", "> > ---- Forwarded message ----\n> From: B"));
});

test("isForwardedMessage is false for replies and plain mail", () => {
  assert.ok(!isForwardedMessage("Re: dinner plans", "sounds good"));
  assert.ok(!isForwardedMessage("dinner plans", "sounds good"));
  // Outlook's reply banner must NOT read as a forward (else every reply re-quotes).
  assert.ok(!isForwardedMessage("Re: dinner", "yes\n-----Original Message-----\nFrom: B"));
  assert.ok(!isForwardedMessage("", ""));
});

// --- selectInboundBody: the truth table ---

const EXTRACTED = "just the new reply";
const FULL = "just the new reply\n\n> quoted history\n> from before";

function base(overrides: Partial<InboundBodyInput> = {}): InboundBodyInput {
  return {
    extractedText: EXTRACTED,
    fullText: FULL,
    isForward: false,
    inReplyTo: undefined,
    threadKnownLocally: false,
    knownMessageIds: new Set<string>(),
    ...overrides,
  };
}

test("normal: thread-opening message uses stripped body", () => {
  const r = selectInboundBody(base({ threadKnownLocally: false, inReplyTo: undefined }));
  assert.equal(r.reason, "normal");
  assert.equal(r.includedHistory, false);
  assert.equal(r.body, EXTRACTED);
});

test("normal: reply on a known thread whose parent we sent/saw uses stripped body", () => {
  const r = selectInboundBody(
    base({
      threadKnownLocally: true,
      inReplyTo: "buri-reply@x.com",
      knownMessageIds: new Set(["msg1@x.com", "buri-reply@x.com"]),
    }),
  );
  assert.equal(r.reason, "normal");
  assert.equal(r.body, EXTRACTED);
});

test("forward: always includes history and wins over every other signal", () => {
  const r = selectInboundBody(
    base({
      isForward: true,
      threadKnownLocally: true,
      inReplyTo: "buri-reply@x.com",
      knownMessageIds: new Set(["buri-reply@x.com"]),
    }),
  );
  assert.equal(r.reason, "forward");
  assert.equal(r.includedHistory, true);
  assert.equal(r.body, FULL);
});

test("loop-in: reply into an unknown thread includes history", () => {
  const r = selectInboundBody(
    base({ threadKnownLocally: false, inReplyTo: "external@x.com" }),
  );
  assert.equal(r.reason, "loop-in");
  assert.equal(r.body, FULL);
});

test("gap: reply on a known thread whose parent we never saw includes history", () => {
  const r = selectInboundBody(
    base({
      threadKnownLocally: true,
      inReplyTo: "side-convo@x.com",
      knownMessageIds: new Set(["msg1@x.com"]),
    }),
  );
  assert.equal(r.reason, "gap");
  assert.equal(r.body, FULL);
});

test("empty: no candidate has content", () => {
  const r = selectInboundBody(base({ extractedText: "  ", fullText: "\n\t" }));
  assert.equal(r.reason, "empty");
  assert.equal(r.includedHistory, false);
  assert.equal(r.body, "");
});

test("fallback: history wanted but full body blank falls back to extracted", () => {
  const r = selectInboundBody(
    base({ isForward: true, fullText: "   ", extractedText: EXTRACTED }),
  );
  assert.equal(r.reason, "forward");
  assert.equal(r.body, EXTRACTED);
});

test("fallback: normal wanted but extracted blank falls back to full", () => {
  const r = selectInboundBody(
    base({ inReplyTo: undefined, extractedText: "", fullText: FULL }),
  );
  assert.equal(r.reason, "normal");
  assert.equal(r.body, FULL);
});

// --- The user's motivating scenarios, end to end ---

test("scenario Branch A: side conversation looped back on the same thread → gap", () => {
  // A→Buri (msg1) is all Buri saw. B↔A happened off Buri's inbox. A replies to
  // B's last message and re-adds Buri: In-Reply-To points at an id Buri never saw.
  const r = selectInboundBody(
    base({
      threadKnownLocally: true,
      inReplyTo: "b-private@mail.com",
      knownMessageIds: new Set(["msg1-a-to-buri@mail.com"]),
      isForward: false,
    }),
  );
  assert.equal(r.reason, "gap");
  assert.equal(r.body, FULL, "must surface the quoted side-conversation history");
});

test("scenario Branch A guard: an ongoing reply where Buri did reply → normal", () => {
  const r = selectInboundBody(
    base({
      threadKnownLocally: true,
      inReplyTo: "buri-reply-2@mail.com",
      knownMessageIds: new Set(["msg1@mail.com", "buri-reply-2@mail.com"]),
    }),
  );
  assert.equal(r.reason, "normal", "a direct reply to Buri must not re-quote");
});

test("scenario Branch B: forwarded loop-back that lands as a new thread → history preserved", () => {
  // As a forward:
  assert.equal(selectInboundBody(base({ isForward: true })).reason, "forward");
  // Or as a reply that AgentMail files under a brand-new thread_id:
  assert.equal(
    selectInboundBody(base({ threadKnownLocally: false, inReplyTo: "ext@mail.com" })).reason,
    "loop-in",
  );
});

// --- Stress test: invariants over seeded-random inputs ---

// Deterministic PRNG (mulberry32) so failures reproduce exactly.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Compute the expected reason independently of the implementation. */
function expectedReason(i: InboundBodyInput): InboundBodyReason {
  const bothBlank = !i.extractedText.trim() && !i.fullText.trim();
  let r: InboundBodyReason;
  if (i.isForward) r = "forward";
  else if (i.inReplyTo && !i.threadKnownLocally) r = "loop-in";
  else if (i.inReplyTo && !i.knownMessageIds.has(i.inReplyTo)) r = "gap";
  else r = "normal";
  return bothBlank ? "empty" : r;
}

test("stress: selectInboundBody upholds its invariants across 20k random inputs", () => {
  const rand = mulberry32(0xc0ffee);
  const pickText = (): string => {
    const roll = rand();
    if (roll < 0.15) return ""; // blank
    if (roll < 0.25) return "   \n\t "; // whitespace-only
    return `body-${Math.floor(rand() * 1000)}`;
  };
  const idPool = ["a@x", "b@x", "c@x", "buri@x", "side@x"];

  for (let n = 0; n < 20_000; n++) {
    const isForward = rand() < 0.3;
    const hasParent = rand() < 0.7;
    const inReplyTo = hasParent
      ? idPool[Math.floor(rand() * idPool.length)]
      : undefined;
    const threadKnownLocally = rand() < 0.6;
    const known = new Set<string>();
    for (const id of idPool) if (rand() < 0.4) known.add(id);

    const extractedText = pickText();
    const fullText = pickText();

    const input: InboundBodyInput = {
      extractedText,
      fullText,
      isForward,
      inReplyTo,
      threadKnownLocally,
      knownMessageIds: known,
    };
    const out = selectInboundBody(input);
    const ctx = () => JSON.stringify({ ...input, knownMessageIds: [...known] });

    // 1. Reason matches an independent re-derivation.
    assert.equal(out.reason, expectedReason(input), `reason mismatch: ${ctx()}`);

    // 2. "normal" never includes history; the history reasons always do
    //    (unless the result collapsed to empty).
    if (out.reason === "normal") assert.equal(out.includedHistory, false, ctx());
    if (out.reason === "forward" || out.reason === "loop-in" || out.reason === "gap") {
      assert.equal(out.includedHistory, true, ctx());
    }
    if (out.reason === "empty") assert.equal(out.includedHistory, false, ctx());

    // 3. Body is empty iff both candidates were blank.
    const bothBlank = !extractedText.trim() && !fullText.trim();
    assert.equal(out.body === "", bothBlank, `body/empty mismatch: ${ctx()}`);

    // 4. The returned body is always one of the two supplied candidates.
    if (out.body !== "") {
      assert.ok(
        out.body === extractedText || out.body === fullText,
        `body not a supplied candidate: ${ctx()}`,
      );
    }

    // 5. When history is included and the full body has content, we return it
    //    verbatim (never silently downgrade to the stripped body).
    if (out.includedHistory && fullText.trim()) {
      assert.equal(out.body, fullText, `did not prefer full body: ${ctx()}`);
    }
    // ...and symmetrically, a normal turn prefers the stripped body when present.
    if (out.reason === "normal" && extractedText.trim()) {
      assert.equal(out.body, extractedText, `did not prefer stripped body: ${ctx()}`);
    }
  }
});

test("stress: forward always wins regardless of other inputs", () => {
  const rand = mulberry32(0x1234);
  for (let n = 0; n < 5_000; n++) {
    const out = selectInboundBody({
      extractedText: "x",
      fullText: "x\n> y",
      isForward: true,
      inReplyTo: rand() < 0.5 ? "p@x" : undefined,
      threadKnownLocally: rand() < 0.5,
      knownMessageIds: rand() < 0.5 ? new Set(["p@x"]) : new Set(),
    });
    assert.equal(out.reason, "forward");
    assert.equal(out.body, "x\n> y");
  }
});
