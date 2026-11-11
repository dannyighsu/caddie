/**
 * pnpm eval <suite> [options]      run a suite
 * pnpm eval list [suite]           list suites, or a suite's cases
 *
 * Options:
 *   --case a,b         only these case ids (prefix match)
 *   --tag t            only cases with this tag
 *   --trials N         runs per case; a case passes only if all pass (default 1)
 *   --model M          agent model (default claude-sonnet-5 — the bar is a
 *                      weaker model than production's)
 *   --effort E         reasoning effort (default medium, as in production)
 *   --concurrency N    parallel trials (default 4)
 *   --no-judge         skip rubric assertions
 *   --judge-model M    model for rubric assertions (default claude-opus-5-5)
 *   --keep-sandbox     keep evals/.sandbox/<run> for debugging
 */

import { relative, resolve } from "path";
import { loadSuite, listSuites } from "../core/load.ts";
import { runSuite, type RunConfig } from "../core/runner.ts";
import { fakeRoster, closeLiveRoster } from "../core/team.ts";
import { primeTeamRoster } from "../core/portal.ts";

const DEFAULTS: RunConfig = {
  model: "claude-sonnet-5",
  effort: "medium",
  trials: 1,
  concurrency: 4,
  judge: true,
  judgeModel: "claude-opus-5-5",
  keepSandbox: false,
};

function usage(): never {
  console.error("usage: pnpm eval <suite> [--case ids] [--tag t] [--trials N] [--model M] [--no-judge] …\n       pnpm eval list [suite]");
  process.exit(2);
}

async function main() {
  const argv = process.argv.slice(2).filter((a) => a !== "--");
  const positional: string[] = [];
  const cfg = { ...DEFAULTS };
  let caseFilter: string[] | undefined;
  let tag: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? usage();
    switch (a) {
      case "--case": caseFilter = val().split(","); break;
      case "--tag": tag = val(); break;
      case "--trials": cfg.trials = Number(val()); break;
      case "--model": cfg.model = val(); break;
      case "--effort": cfg.effort = val(); break;
      case "--concurrency": cfg.concurrency = Number(val()); break;
      case "--no-judge": cfg.judge = false; break;
      case "--judge-model": cfg.judgeModel = val(); break;
      case "--keep-sandbox": cfg.keepSandbox = true; break;
      case "-h": case "--help": usage();
      default:
        if (a.startsWith("--")) usage();
        positional.push(a);
    }
  }

  if (positional[0] === "list") {
    if (!positional[1]) {
      for (const s of await listSuites()) console.log(s);
      return;
    }
    const suite = await loadSuite(positional[1]);
    for (const c of suite.cases) console.log(`${c.id.padEnd(40)} ${c.tags.join(", ")}`);
    return;
  }

  const suiteName = positional[0] ?? usage();
  const suite = await loadSuite(suiteName);
  let cases = suite.cases;
  if (caseFilter) cases = cases.filter((c) => caseFilter!.some((f) => c.id.startsWith(f)));
  if (tag) cases = cases.filter((c) => c.tags.includes(tag!));
  if (cases.length === 0) {
    console.error("No cases selected.");
    process.exit(2);
  }

  // Every run uses the fake team, so identity labels, the team directory and
  // email_team all agree with the anonymized case files. The driver hands the
  // same roster to the launcher.
  primeTeamRoster(fakeRoster());

  console.log(`${suiteName}: ${cases.length} case(s) × ${cfg.trials} on ${cfg.model}${cfg.judge ? `, judge ${cfg.judgeModel}` : ""}`);
  const summary = await runSuite(suiteName, suite, cases, cfg);
  await closeLiveRoster();
  const passed = summary.cases.filter((c) => c.passed).length;
  console.log(`\n${passed}/${summary.cases.length} passed · report: ${relative(process.cwd(), resolve(summary.resultsDir, "report.md"))}`);
  process.exit(passed === summary.cases.length ? 0 : 1);
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(2);
});
