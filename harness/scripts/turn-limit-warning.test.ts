import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SCRIPT = join(__dirname, "turn-limit-warning.sh");

function runHook(
  transcriptPath: string,
  maxTurns: number = 150
): string {
  const input = JSON.stringify({ transcript_path: transcriptPath });
  try {
    return execSync(`echo '${input}' | bash "${SCRIPT}"`, {
      env: { ...process.env, HARNESS_MAX_TURNS: String(maxTurns) },
      encoding: "utf-8",
    }).trim();
  } catch (e: any) {
    return e.stdout?.trim() ?? "";
  }
}

function makeTranscript(assistantTurnCount: number): string {
  const dir = join(tmpdir(), `turn-limit-test-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "transcript.jsonl");
  const lines: string[] = [];
  for (let i = 0; i < assistantTurnCount; i++) {
    lines.push(JSON.stringify({ role: "assistant", content: `turn ${i}` }));
    lines.push(JSON.stringify({ role: "user", content: `prompt ${i}` }));
  }
  writeFileSync(path, lines.join("\n"));
  return path;
}

let tmpPaths: string[] = [];

beforeEach(() => {
  tmpPaths = [];
});

afterEach(() => {
  for (const p of tmpPaths) {
    rmSync(p, { recursive: true, force: true });
  }
});

function tracked(path: string): string {
  const dir = join(path, "..");
  tmpPaths.push(dir);
  return path;
}

describe("turn-limit-warning.sh", () => {
  it("emits no output when well below the limit", () => {
    const tp = tracked(makeTranscript(50));
    const output = runHook(tp, 150);
    expect(output).toBe("");
  });

  it("emits no output at 21 turns remaining", () => {
    const tp = tracked(makeTranscript(129));
    const output = runHook(tp, 150);
    expect(output).toBe("");
  });

  it("emits NOTICE at 20 turns remaining", () => {
    const tp = tracked(makeTranscript(130));
    const output = runHook(tp, 150);
    expect(output).not.toBe("");
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("TURN LIMIT NOTICE");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("20 turns left");
  });

  it("emits WARNING at 10 turns remaining", () => {
    const tp = tracked(makeTranscript(140));
    const output = runHook(tp, 150);
    expect(output).not.toBe("");
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("TURN LIMIT WARNING");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("10 turns left");
  });

  it("emits CRITICAL at 5 turns remaining", () => {
    const tp = tracked(makeTranscript(145));
    const output = runHook(tp, 150);
    expect(output).not.toBe("");
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("CRITICAL");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("5 turns left");
  });

  it("emits CRITICAL at 0 turns remaining", () => {
    const tp = tracked(makeTranscript(150));
    const output = runHook(tp, 150);
    expect(output).not.toBe("");
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("CRITICAL");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("0 turns left");
  });

  it("clamps remaining to 0 when over max", () => {
    const tp = tracked(makeTranscript(160));
    const output = runHook(tp, 150);
    expect(output).not.toBe("");
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("0 turns left");
  });

  it("uses default max turns of 150 when env var is not set", () => {
    const tp = tracked(makeTranscript(135));
    const input = JSON.stringify({ transcript_path: tp });
    const output = execSync(`echo '${input}' | bash "${SCRIPT}"`, {
      env: { ...process.env, HARNESS_MAX_TURNS: undefined },
      encoding: "utf-8",
    }).trim();
    expect(output).not.toBe("");
    const parsed = JSON.parse(output);
    expect(parsed.hookSpecificOutput.additionalContext).toContain("150");
  });

  it("produces no output for missing transcript", () => {
    const output = runHook("/nonexistent/path.jsonl", 150);
    expect(output).toBe("");
  });

  it("produces no output for empty input", () => {
    try {
      const result = execSync(`echo '{}' | bash "${SCRIPT}"`, {
        env: { ...process.env, HARNESS_MAX_TURNS: "150" },
        encoding: "utf-8",
      }).trim();
      expect(result).toBe("");
    } catch (e: any) {
      expect(e.stdout?.trim() ?? "").toBe("");
    }
  });
});
