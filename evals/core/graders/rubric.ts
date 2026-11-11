/**
 * Model-graded assertions, for the judgment calls string checks can't make
 * ("no filler", "doesn't re-ask what was answered"). Each rubric is a pass/fail
 * question the judge answers from the case and what the run did — never a
 * score. Deterministic assertions stay the backbone; a rubric should cover what
 * they can't, not repeat them.
 *
 * The judge runs through the `claude` CLI (already authenticated for the runs
 * themselves) with tools off, in the trial's own directory.
 */

import { spawn } from "child_process";
import type { AssertionResult, Evidence, LoadedCase } from "../types.ts";
import { label } from "./tools.ts";

export interface JudgeOptions {
  model: string;
  cwd: string;
}

export async function gradeRubric(
  rubric: string,
  c: LoadedCase,
  ev: Evidence,
  opts: JudgeOptions,
  assertion: AssertionResult["assertion"]
): Promise<AssertionResult> {
  const actions = ev.toolCalls
    .filter((t) => !["ToolSearch", "Skill"].includes(t.name))
    .map((t) => `- ${t.name}(${JSON.stringify(t.input)})`)
    .join("\n");
  const prompt = [
    "You are grading one run of an AI executive assistant against a single pass/fail criterion.",
    "Judge only the criterion. Don't grade anything else, and don't be lenient about it either.",
    "",
    "## What the assistant was given (the inbound message and context)",
    ev.prompt,
    "",
    "## What the assistant did (tool calls, in order; `reply` answers the sender, `email_team` goes only to its team)",
    actions || "(no tool calls — it stayed silent)",
    "",
    "## Criterion",
    rubric,
    "",
    c.notes ? `## Case notes from the author\n${c.notes}\n` : "",
    'Answer with exactly one line: "PASS" or "FAIL: <one-sentence reason>".',
  ].join("\n");

  try {
    const out = await runClaude(prompt, opts);
    const line = out.trim().split("\n").find((l) => /^(PASS|FAIL)/i.test(l.trim()))?.trim() ?? out.trim();
    const pass = /^PASS/i.test(line);
    return { assertion, label: label(assertion), status: pass ? "pass" : "fail", detail: pass ? undefined : line.replace(/^FAIL:?\s*/i, "") };
  } catch (err) {
    return { assertion, label: label(assertion), status: "fail", detail: `judge error: ${(err as Error).message}` };
  }
}

function runClaude(prompt: string, opts: JudgeOptions): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.env.CLAUDE_BINARY ?? "claude",
      ["-p", prompt, "--model", opts.model, "--output-format", "json", "--max-turns", "1", "--tools", "", "--strict-mcp-config"],
      { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `exit ${code}`));
      try {
        resolvePromise(String(JSON.parse(stdout).result ?? ""));
      } catch {
        resolvePromise(stdout);
      }
    });
  });
}
