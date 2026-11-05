/**
 * Tests for the transcript parser — the rules that decide which of a run's
 * JSONL entries become auditable steps.
 *
 * The case that matters most here: a run that delegates work to subagents must
 * still be auditable afterwards. Both of the parser's old dropping rules broke
 * that — entries whose `type` was neither "assistant" nor "user" were skipped
 * outright, and tool results were cut at 1000 characters, which is well inside
 * a typical hand-back report.
 *
 * Run: node --test --experimental-strip-types lib/transcripts.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTranscript, MAX_TOOL_RESULT_CHARS } from "./transcript-parse.ts";

const jsonl = (...entries: unknown[]) => entries.map((e) => JSON.stringify(e)).join("\n");

test("keeps assistant text, thinking and tool calls", () => {
  const steps = parseTranscript(
    jsonl(
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "weighing it up" },
            { type: "text", text: "Here is the answer." },
            { type: "tool_use", name: "WebSearch", input: { query: "straia" } },
          ],
        },
      }
    )
  );

  assert.deepEqual(
    steps.map((s) => [s.role, s.type]),
    [
      ["assistant", "thinking"],
      ["assistant", "text"],
      ["assistant", "tool_use"],
    ]
  );
  assert.equal(steps[2].toolName, "WebSearch");
  assert.deepEqual(steps[2].toolInput, { query: "straia" });
});

test("keeps a conversation entry whose type is not assistant or user", () => {
  // A background subagent's completion notification arrives this way: the entry
  // type is something else entirely and the role lives on the message. Matching
  // on `type` alone dropped the report the parent wrote its answer from.
  const steps = parseTranscript(
    jsonl({
      type: "progress",
      message: {
        role: "user",
        content: [{ type: "text", text: "Agent report: Straia raised an undisclosed pre-seed." }],
      },
    })
  );

  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "text");
  assert.match(steps[0].content, /undisclosed pre-seed/);
});

test("tags steps from a subagent conversation as sidechain", () => {
  const steps = parseTranscript(
    jsonl(
      {
        type: "assistant",
        isSidechain: true,
        message: { role: "assistant", content: [{ type: "text", text: "found it" }] },
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "parent speaking" }] },
      }
    )
  );

  assert.equal(steps[0].sidechain, true);
  assert.equal(steps[1].sidechain, undefined);
});

test("keeps a long tool result far past the old 1000-character cap", () => {
  // A subagent hand-back report, with the auditable figure late in the body.
  const report = `${"filler ".repeat(500)}committed ARR was $4.5M`;
  assert.ok(report.length > 1000);

  const steps = parseTranscript(
    jsonl({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: report }],
      },
    })
  );

  assert.equal(steps.length, 1);
  assert.equal(steps[0].type, "tool_result");
  assert.equal(steps[0].toolName, "toolu_1");
  assert.match(steps[0].content, /committed ARR was \$4\.5M/);
});

test("clips an oversized tool result and says how much it dropped", () => {
  const huge = "x".repeat(MAX_TOOL_RESULT_CHARS + 250);
  const steps = parseTranscript(
    jsonl({
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: huge }] },
    })
  );

  assert.match(steps[0].content, /\[truncated 250 more characters\]/);
});

test("flattens a tool result delivered as content blocks", () => {
  const steps = parseTranscript(
    jsonl({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: [{ type: "text", text: "line one" }, { type: "text", text: "line two" }] }],
      },
    })
  );

  assert.equal(steps[0].content, "line one\nline two");
});

test("keeps a bare-string user prompt", () => {
  const steps = parseTranscript(jsonl({ type: "user", message: { role: "user", content: "do the thing" } }));
  assert.deepEqual(steps, [{ role: "user", type: "text", content: "do the thing" }]);
});

test("skips bookkeeping entries and unparseable lines", () => {
  const steps = parseTranscript(
    [
      JSON.stringify({ type: "file-history-snapshot", message: { role: "user", content: [{ type: "text", text: "snapshot" }] } }),
      JSON.stringify({ type: "last-prompt", message: { role: "user", content: [{ type: "text", text: "prompt echo" }] } }),
      "{not json",
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "real step" }] } }),
    ].join("\n")
  );

  assert.deepEqual(steps.map((s) => s.content), ["real step"]);
});

test("carries the entry timestamp onto its steps", () => {
  const steps = parseTranscript(
    jsonl({
      type: "assistant",
      timestamp: "2026-11-05T16:56:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    })
  );
  assert.equal(steps[0].timestamp, "2026-11-05T16:56:00.000Z");
});
