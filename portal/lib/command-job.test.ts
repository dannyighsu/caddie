/**
 * Tests for command jobs — the validation, containment and output rules that
 * decide whether a scheduled command wakes the agent.
 *
 * Run: node --test --experimental-strip-types lib/command-job.test.ts
 * (also wired as `pnpm test` in package.json)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveCwd,
  parseCommandSpec,
  truncateOutput,
  buildEnv,
  buildFollowupPrompt,
  runCommand,
  MAX_OUTPUT_CHARS,
  MAX_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
} from "./command-job.ts";

// A path that does not exist on disk — fine for the pure validation tests,
// which never spawn anything.
const WS = "/home/someone/.caddie";

// A real directory for the tests that actually run a command.
const REAL_WS = mkdtempSync(join(tmpdir(), "command-job-"));

// --- cwd containment ---

test("cwd defaults to the workspace root", () => {
  assert.equal(resolveCwd(WS), WS);
});

test("a relative cwd resolves inside the workspace", () => {
  assert.equal(resolveCwd(WS, "mounts/library"), `${WS}/mounts/library`);
});

test("an absolute cwd is rejected", () => {
  assert.throws(() => resolveCwd(WS, "/etc"), /workspace-relative/);
});

test("a cwd that climbs out of the workspace is rejected", () => {
  assert.throws(() => resolveCwd(WS, "../../etc"), /escapes the workspace/);
  assert.throws(() => resolveCwd(WS, "mounts/../../elsewhere"), /escapes the workspace/);
});

test("a sibling directory sharing the workspace prefix is rejected", () => {
  // Guards the string-prefix check: "/home/someone/.caddie-evil" starts with
  // the workspace path but is not inside it.
  assert.throws(() => resolveCwd(WS, "../.caddie-evil"), /escapes the workspace/);
});

// --- spec validation ---

test("a minimal notify command job parses with defaults", () => {
  const spec = parseCommandSpec({ command: "./poll.sh", onOutput: "notify" }, WS);
  assert.equal(spec.command, "./poll.sh");
  assert.equal(spec.cwd, WS);
  assert.equal(spec.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(spec.onOutput, "notify");
  assert.deepEqual(spec.env, []);
});

test("onOutput defaults to run, which requires a prompt", () => {
  assert.throws(() => parseCommandSpec({ command: "./poll.sh" }, WS), /requires a `prompt`/);
  const spec = parseCommandSpec({ command: "./poll.sh", prompt: "handle it" }, WS);
  assert.equal(spec.onOutput, "run");
});

test("a missing or empty command is rejected", () => {
  assert.throws(() => parseCommandSpec({}, WS), /non-empty `command`/);
  assert.throws(() => parseCommandSpec({ command: "   " }, WS), /non-empty `command`/);
});

test("an unknown onOutput is rejected", () => {
  assert.throws(
    () => parseCommandSpec({ command: "x", onOutput: "email" }, WS),
    /onOutput` must be one of/
  );
});

test("the command timeout is bounded", () => {
  assert.throws(
    () => parseCommandSpec({ command: "x", onOutput: "ignore", commandTimeoutMs: MAX_TIMEOUT_MS + 1 }, WS),
    /at most/
  );
  assert.throws(
    () => parseCommandSpec({ command: "x", onOutput: "ignore", commandTimeoutMs: 0 }, WS),
    /positive number/
  );
  const spec = parseCommandSpec({ command: "x", onOutput: "ignore", commandTimeoutMs: 5000 }, WS);
  assert.equal(spec.timeoutMs, 5000);
});

test("commandEnv must be a list of names", () => {
  assert.throws(
    () => parseCommandSpec({ command: "x", onOutput: "ignore", commandEnv: "TOKEN" }, WS),
    /array of environment variable names/
  );
  const spec = parseCommandSpec(
    { command: "x", onOutput: "ignore", commandEnv: ["TOKEN", "HOME"] },
    WS
  );
  assert.deepEqual(spec.env, ["TOKEN", "HOME"]);
});

// --- env passthrough ---

test("only named variables are forwarded, and secrets are not forwarded by default", () => {
  const source = { PATH: "/bin", HOME: "/home/x", SECRET: "s3cret", WANTED: "yes" };
  const bare = buildEnv(parseCommandSpec({ command: "x", onOutput: "ignore" }, WS), source);
  assert.equal(bare.PATH, "/bin");
  assert.equal(bare.SECRET, undefined, "an unnamed secret must not leak into the command");

  const withEnv = buildEnv(
    parseCommandSpec({ command: "x", onOutput: "ignore", commandEnv: ["WANTED"] }, WS),
    source
  );
  assert.equal(withEnv.WANTED, "yes");
  assert.equal(withEnv.SECRET, undefined);
});

test("a named variable that isn't set is skipped rather than forwarded as undefined", () => {
  const env = buildEnv(
    parseCommandSpec({ command: "x", onOutput: "ignore", commandEnv: ["NOPE"] }, WS),
    { PATH: "/bin" }
  );
  assert.ok(!("NOPE" in env));
});

// --- output handling ---

test("output under the cap is untouched", () => {
  const { text, truncated } = truncateOutput("two lines\nhere");
  assert.equal(text, "two lines\nhere");
  assert.equal(truncated, false);
});

test("output over the cap is clipped and flagged", () => {
  const { text, truncated } = truncateOutput("x".repeat(MAX_OUTPUT_CHARS + 500));
  assert.equal(truncated, true);
  assert.match(text, /truncated 500 more characters/);
  assert.ok(text.length < MAX_OUTPUT_CHARS + 200);
});

test("the follow-up prompt carries the job prompt and the output that woke it", () => {
  const prompt = buildFollowupPrompt(
    "/granola-followup",
    "./poll.py",
    "call-123 Jane Doe\n",
    new Date("2026-11-04T19:00:00Z")
  );
  assert.match(prompt, /^\/granola-followup/);
  assert.match(prompt, /call-123 Jane Doe/);
  assert.match(prompt, /\.\/poll\.py/);
  assert.match(prompt, /2026-11-04T19:00:00\.000Z/);
});

// --- running (integration against a real shell) ---

test("a quiet command yields no output and exit 0", async () => {
  const result = await runCommand(
    parseCommandSpec({ command: "true", onOutput: "ignore" }, REAL_WS)
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.timedOut, false);
});

test("shell operators work, since job specs are command lines", async () => {
  const result = await runCommand(
    parseCommandSpec({ command: "echo one && echo two", onOutput: "ignore" }, REAL_WS)
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), "one\ntwo");
});

test("a non-zero exit is reported on the result, not thrown", async () => {
  const result = await runCommand(
    parseCommandSpec({ command: "echo bad >&2; exit 3", onOutput: "ignore" }, REAL_WS)
  );
  assert.equal(result.exitCode, 3);
  assert.match(result.stderr, /bad/);
});

test("a command that overruns its timeout is killed and flagged", async () => {
  const result = await runCommand(
    parseCommandSpec({ command: "sleep 5", onOutput: "ignore", commandTimeoutMs: 250 }, REAL_WS)
  );
  assert.equal(result.timedOut, true);
  assert.notEqual(result.exitCode, 0);
});

test("the command runs in its configured working directory", async () => {
  const result = await runCommand(parseCommandSpec({ command: "pwd", onOutput: "ignore" }, "/tmp"));
  assert.equal(result.stdout.trim(), "/tmp");
});

test("a working directory that does not exist is a spawn failure, not a crash", async () => {
  // parseCommandSpec validates containment, not existence — a cwd that was
  // swept (an expired repo mount, say) surfaces here.
  const result = await runCommand(
    parseCommandSpec({ command: "true", onOutput: "ignore" }, "/home/nobody/does-not-exist")
  );
  assert.ok(result.spawnError, "expected a spawn error");
  assert.equal(result.exitCode, null);
});
