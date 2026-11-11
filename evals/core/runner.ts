/**
 * Run a suite: every selected case × N trials through the suite's driver,
 * graded, with evidence and a report written under results/.
 *
 * A case passes only if every trial passes (pass^k) — for mail that goes to
 * real people, "usually right" isn't the bar.
 */

import { mkdir, rm, writeFile } from "fs/promises";
import { resolve } from "path";
import type { AssertionResult, Evidence, LoadedCase } from "./types.ts";
import { EVALS_ROOT, type LoadedSuite } from "./load.ts";
import { gradeDeterministic, label } from "./graders/tools.ts";
import { gradeRubric } from "./graders/rubric.ts";
import { writeReport } from "./report.ts";

export interface RunConfig {
  model: string;
  effort?: string;
  trials: number;
  concurrency: number;
  judge: boolean;
  judgeModel: string;
  keepSandbox: boolean;
}

export interface TrialResult {
  caseId: string;
  trial: number;
  passed: boolean;
  results: AssertionResult[];
  evidence: Evidence;
  evidenceDir: string;
}

export interface CaseSummary {
  case: LoadedCase;
  trials: TrialResult[];
  passed: boolean;
}

export interface RunSummary {
  suite: string;
  runId: string;
  config: RunConfig;
  startedAt: string;
  durationMs: number;
  cases: CaseSummary[];
  resultsDir: string;
}

export async function runSuite(
  suiteName: string,
  suite: LoadedSuite,
  cases: LoadedCase[],
  cfg: RunConfig,
  log: (line: string) => void = console.log
): Promise<RunSummary> {
  const startedAt = new Date();
  const runId = `${suiteName}-${startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;
  const resultsDir = resolve(EVALS_ROOT, "results", runId);
  const sandboxRoot = resolve(EVALS_ROOT, ".sandbox", runId);
  await mkdir(resultsDir, { recursive: true });

  const jobs = cases.flatMap((c) => Array.from({ length: cfg.trials }, (_, i) => ({ c, trial: i + 1 })));
  const done: TrialResult[] = [];
  let next = 0;

  async function worker() {
    while (next < jobs.length) {
      const { c, trial } = jobs[next++];
      const tag = cfg.trials > 1 ? `${c.id} #${trial}` : c.id;
      const runDir = resolve(sandboxRoot, c.id, `trial-${trial}`);
      const evidenceDir = resolve(resultsDir, c.id, `trial-${trial}`);
      log(`  … ${tag}`);
      const r = await runTrial(suite, c, trial, runDir, evidenceDir, cfg);
      done.push(r);
      const failed = r.results.filter((x) => x.status === "fail");
      log(`  ${r.passed ? "✓" : "✗"} ${tag}${failed.length ? ` — ${failed.map((f) => `${f.label}: ${f.detail}`).join("; ")}` : ""}`);
      if (!cfg.keepSandbox) await rm(runDir, { recursive: true, force: true });
    }
  }
  await Promise.all(Array.from({ length: Math.min(cfg.concurrency, jobs.length) }, worker));
  if (!cfg.keepSandbox) await rm(sandboxRoot, { recursive: true, force: true });

  const summary: RunSummary = {
    suite: suiteName,
    runId,
    config: cfg,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    resultsDir,
    cases: cases.map((c) => {
      const trials = done.filter((t) => t.caseId === c.id).sort((a, b) => a.trial - b.trial);
      return { case: c, trials, passed: trials.length > 0 && trials.every((t) => t.passed) };
    }),
  };
  await writeReport(summary);
  return summary;
}

async function runTrial(
  suite: LoadedSuite,
  c: LoadedCase,
  trial: number,
  runDir: string,
  evidenceDir: string,
  cfg: RunConfig
): Promise<TrialResult> {
  let evidence: Evidence;
  try {
    evidence = await suite.driver.run(c, suite.config, {
      model: cfg.model,
      effort: cfg.effort,
      trial,
      runDir,
      evidenceDir,
      keepSandbox: cfg.keepSandbox,
    });
  } catch (err) {
    evidence = {
      caseId: c.id,
      trial,
      model: cfg.model,
      success: false,
      error: (err as Error).stack ?? String(err),
      prompt: "",
      toolCalls: [],
      outbound: [],
      durationMs: 0,
    };
  }

  const results: AssertionResult[] = [];
  if (!evidence.success) {
    results.push({
      assertion: { rubric: "run completed" },
      label: "run completed",
      status: "fail",
      detail: (evidence.error ?? "run failed").split("\n")[0],
    });
  }
  for (const a of c.expect) {
    const det = gradeDeterministic(a, evidence);
    if (det) {
      results.push(det);
    } else if ("rubric" in a) {
      results.push(
        cfg.judge && evidence.success
          ? await gradeRubric(a.rubric, c, evidence, { model: cfg.judgeModel, cwd: evidenceDir }, a)
          : { assertion: a, label: label(a), status: "skipped", detail: cfg.judge ? "run failed" : "judge disabled" }
      );
    }
  }

  const passed = results.every((r) => r.status !== "fail");
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(resolve(evidenceDir, "evidence.json"), JSON.stringify({ passed, results, evidence }, null, 2));
  return { caseId: c.id, trial, passed, results, evidence, evidenceDir };
}
