/**
 * Command jobs — scheduled shell commands that don't cost an agent run.
 *
 * A `command` job runs one shell command on its cron and decides what to do
 * from the command's *output*. The point is the cheap poll: a 5-minute poller
 * that prints nothing on a quiet tick costs a subprocess, not a full agent
 * turn. An agent run only happens on the ticks that produce output.
 *
 * `onOutput` picks what empty-vs-nonempty stdout means:
 *   - "run"    — launch the agent, with the output appended to the job prompt.
 *   - "notify" — send the output to the job's notification channel.
 *   - "ignore" — log only (plain maintenance cron).
 * Empty stdout always means do nothing. A non-zero exit is a job failure and
 * is reported like any other, independently of what stdout held.
 *
 * Everything here except `runCommand` is pure, so the containment and
 * truncation rules are unit-testable (see command-job.test.ts).
 */

import { spawn } from "node:child_process";
import { resolve, sep } from "node:path";

/** What to do when the command writes something to stdout. */
export type OnOutput = "run" | "notify" | "ignore";

export const DEFAULT_ON_OUTPUT: OnOutput = "run";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 10 * 60_000;
/**
 * Cap on captured stdout/stderr. Output becomes an agent prompt or a chat
 * notification, so this is small on purpose: a command that dumps megabytes is
 * misconfigured, and truncating is friendlier than blowing up a run's context
 * or a Slack post.
 */
export const MAX_OUTPUT_CHARS = 16_000;

/** A validated command-job payload. */
export interface CommandSpec {
  command: string;
  /** Absolute, already verified to sit inside the workspace. */
  cwd: string;
  timeoutMs: number;
  onOutput: OnOutput;
  /**
   * Names of environment variables to forward from the portal process. The
   * command otherwise gets a minimal env — see `buildEnv`.
   */
  env: string[];
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  /** Null when the process was killed by a signal or never started. */
  exitCode: number | null;
  /** Set when the command was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
  /** Set when the process could not be spawned at all. */
  spawnError?: string;
  truncated: boolean;
}

/**
 * Resolve a job's working directory against the workspace root.
 *
 * `cwd` is workspace-relative and must stay inside it: a command job is
 * configured through the control API, and the workspace is the only tree the
 * agent is supposed to act in, so "../../" or an absolute path is rejected
 * rather than normalized. Returns the absolute path.
 */
export function resolveCwd(workspace: string, cwd?: string): string {
  const root = resolve(workspace);
  if (!cwd) return root;
  if (cwd.startsWith("/")) {
    throw new Error(`cwd must be workspace-relative, not absolute: ${cwd}`);
  }
  const abs = resolve(root, cwd);
  // `root + sep` so a sibling like "<workspace>-evil" can't pass a prefix test.
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(`cwd escapes the workspace: ${cwd}`);
  }
  return abs;
}

function isOnOutput(v: unknown): v is OnOutput {
  return v === "run" || v === "notify" || v === "ignore";
}

/**
 * Validate a job's `params` into a CommandSpec. Throws on anything malformed —
 * callers surface the message to whoever is creating the schedule.
 */
export function parseCommandSpec(
  params: Record<string, unknown> | undefined,
  workspace: string
): CommandSpec {
  const command = params?.command;
  if (typeof command !== "string" || command.trim() === "") {
    throw new Error("a command job requires a non-empty `command`");
  }

  const rawCwd = params?.cwd;
  if (rawCwd !== undefined && typeof rawCwd !== "string") {
    throw new Error("`cwd` must be a string");
  }
  const cwd = resolveCwd(workspace, rawCwd);

  const rawTimeout = params?.commandTimeoutMs;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    const n = Number(rawTimeout);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error("`commandTimeoutMs` must be a positive number");
    }
    if (n > MAX_TIMEOUT_MS) {
      throw new Error(
        `\`commandTimeoutMs\` must be at most ${MAX_TIMEOUT_MS} (${MAX_TIMEOUT_MS / 60_000} minutes)`
      );
    }
    timeoutMs = n;
  }

  const rawOnOutput = params?.onOutput ?? DEFAULT_ON_OUTPUT;
  if (!isOnOutput(rawOnOutput)) {
    throw new Error('`onOutput` must be one of "run", "notify", "ignore"');
  }

  const rawEnv = params?.commandEnv;
  let env: string[] = [];
  if (rawEnv !== undefined) {
    if (!Array.isArray(rawEnv) || rawEnv.some((n) => typeof n !== "string")) {
      throw new Error("`commandEnv` must be an array of environment variable names");
    }
    env = rawEnv as string[];
  }

  // A "run" command job needs something to tell the agent when it fires.
  if (rawOnOutput === "run" && typeof params?.prompt !== "string") {
    throw new Error('a command job with onOutput "run" requires a `prompt`');
  }

  return { command, cwd, timeoutMs, onOutput: rawOnOutput, env };
}

/** Clip output to MAX_OUTPUT_CHARS, flagging whether anything was dropped. */
export function truncateOutput(
  s: string,
  max: number = MAX_OUTPUT_CHARS
): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return {
    text: `${s.slice(0, max)}\n…[truncated ${s.length - max} more characters]`,
    truncated: true,
  };
}

/**
 * Environment for the command: a minimal base plus explicitly named passthrough.
 *
 * The portal process holds every configured secret, and a command job is a
 * stored string that runs unattended — so the default is to forward nothing and
 * make each needed variable opt in by name on the job. A name that isn't set in
 * the portal's env is skipped rather than forwarded as undefined.
 */
export function buildEnv(
  spec: CommandSpec,
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    PATH: source.PATH,
    HOME: source.HOME,
    LANG: source.LANG,
    TZ: source.TZ,
  };
  for (const name of spec.env) {
    const value = source[name];
    if (value !== undefined) base[name] = value;
  }
  return base;
}

/**
 * Append command output to the job's prompt, so a run that was woken by a
 * poller starts with the lines that woke it already in hand.
 */
export function buildFollowupPrompt(
  basePrompt: string,
  command: string,
  stdout: string,
  now: Date = new Date()
): string {
  return [
    basePrompt,
    "---",
    `The scheduled command below produced output at ${now.toISOString()}, which is why this run started.`,
    "",
    `Command: \`${command}\``,
    "",
    "Output:",
    "```",
    stdout.trimEnd(),
    "```",
  ].join("\n");
}

/** One-line summary of a finished command, for logs and the run ledger. */
export function describeResult(result: CommandResult): string {
  if (result.spawnError) return `failed to start: ${result.spawnError}`;
  if (result.timedOut) return "timed out";
  const bytes = result.stdout.length;
  return `exit ${result.exitCode ?? "signal"}, ${bytes} char(s) of stdout`;
}

/**
 * Run the command and capture its output.
 *
 * Runs through a shell because that is the point of the feature — job specs are
 * ordinary command lines like `git pull -q && ./poll.py`, with pipes and `&&`.
 * Never resolves as a rejection: a spawn failure, non-zero exit and timeout all
 * come back on the result so the caller reports them uniformly.
 *
 * The child is started in its own process group and the whole group is killed on
 * timeout, so a shell that spawned children doesn't leave them running.
 */
export function runCommand(spec: CommandSpec): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(spec.command, {
      cwd: spec.cwd,
      shell: true,
      env: buildEnv(spec),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // Negative pid = the process group, so the shell's children die too.
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, spec.timeoutMs);

    child.stdout?.on("data", (d) => {
      // Keep a little past the cap so `truncated` is accurate, but stay bounded
      // even if the command never stops writing.
      if (stdout.length < MAX_OUTPUT_CHARS * 2) stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT_CHARS * 2) stderr += String(d);
    });

    const settle = (r: Omit<CommandResult, "truncated">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const out = truncateOutput(r.stdout);
      const err = truncateOutput(r.stderr);
      resolvePromise({
        ...r,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
      });
    };

    child.on("error", (err) => {
      settle({ stdout, stderr, exitCode: null, timedOut, spawnError: err.message });
    });

    child.on("close", (code) => {
      settle({ stdout, stderr, exitCode: code, timedOut });
    });
  });
}
