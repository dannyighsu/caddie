import { writeFile } from "fs/promises";
import { relative, resolve } from "path";
import type { RunSummary } from "./runner.ts";

/** Write summary.json and report.md into the run's results directory. */
export async function writeReport(s: RunSummary): Promise<void> {
  const passed = s.cases.filter((c) => c.passed).length;
  const lines: string[] = [
    `# ${s.suite} — ${passed}/${s.cases.length} cases passed`,
    "",
    `Run \`${s.runId}\` · model \`${s.config.model}\`${s.config.effort ? ` (${s.config.effort})` : ""} · ` +
      `${s.config.trials} trial(s) per case, pass = every trial · judge ${s.config.judge ? `\`${s.config.judgeModel}\`` : "off"} · ` +
      `${Math.round(s.durationMs / 1000)}s`,
    "",
    "| | Case | Trials | Tags |",
    "|---|---|---|---|",
    ...s.cases.map((c) => {
      const ok = c.trials.filter((t) => t.passed).length;
      return `| ${c.passed ? "✅" : "❌"} | \`${c.case.id}\` ${c.case.title} | ${ok}/${c.trials.length} | ${c.case.tags.join(", ")} |`;
    }),
    "",
  ];

  for (const c of s.cases.filter((x) => !x.passed)) {
    lines.push(`## ❌ ${c.case.id}`, "", c.case.title, "");
    for (const t of c.trials.filter((x) => !x.passed)) {
      lines.push(`**Trial ${t.trial}** — [evidence](${relative(s.resultsDir, resolve(t.evidenceDir, "evidence.json"))})`, "");
      for (const r of t.results) {
        const mark = r.status === "pass" ? "✓" : r.status === "fail" ? "✗" : "–";
        lines.push(`- ${mark} ${r.label}${r.detail ? ` — ${r.detail}` : ""}${r.assertion.why && r.status === "fail" ? `  \n  _why it matters: ${r.assertion.why}_` : ""}`);
      }
      const acts = t.evidence.toolCalls.filter((x) => !["ToolSearch", "Skill"].includes(x.name));
      lines.push(
        "",
        `Tool calls: ${acts.length ? acts.map((x) => `\`${x.name}\``).join(" → ") : "none"}${t.evidence.nudged ? " (after reply reminder)" : ""}`
      );
      for (const o of t.evidence.outbound) {
        lines.push("", `> **${o.kind}** to ${o.to.join(", ") || "?"}${o.external ? " (external)" : ""}${o.subject ? ` — ${o.subject}` : ""}`);
        lines.push(...o.body.split("\n").map((l) => `> ${l}`));
      }
      lines.push("");
    }
  }

  await writeFile(resolve(s.resultsDir, "report.md"), lines.join("\n"));
  await writeFile(
    resolve(s.resultsDir, "summary.json"),
    JSON.stringify(
      {
        suite: s.suite,
        runId: s.runId,
        config: s.config,
        startedAt: s.startedAt,
        durationMs: s.durationMs,
        passed,
        total: s.cases.length,
        cases: s.cases.map((c) => ({
          id: c.case.id,
          passed: c.passed,
          trials: c.trials.map((t) => ({
            trial: t.trial,
            passed: t.passed,
            failures: t.results.filter((r) => r.status === "fail").map((r) => `${r.label}: ${r.detail ?? ""}`),
          })),
        })),
      },
      null,
      2
    )
  );
}
