/**
 * X Manager Gateway Route
 *
 * Orchestrates sequential feed scan + metrics check workflows.
 * Reads config from workspace, builds run record path, launches both workflows,
 * aggregates results into a Slack digest.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { getLauncher } from "@/lib/harness";
import { isRunActive, setActiveRun, clearActiveRun, scheduleRun } from "@/lib/redis";
import { sendMessage, isSlackConfigured } from "@/lib/slack";
import { NextRequest, NextResponse } from "next/server";

const WORKSPACE_ROOT = resolve(process.cwd(), "workspace");

async function readConfigFile(workflowId: string, filename: string): Promise<string> {
  try {
    return await readFile(
      resolve(WORKSPACE_ROOT, workflowId, "config", filename),
      "utf-8"
    );
  } catch {
    return "";
  }
}

function buildRunRecordPath(): string {
  const now = new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const year = pst.getFullYear();
  const month = String(pst.getMonth() + 1).padStart(2, "0");
  const day = String(pst.getDate());
  const dayName = pst.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
  const ts = now.toISOString().replace(/:/g, "-").replace(/\..+/, "");
  return `runs/${year}-${month}/${day}_${dayName}/run-record-${ts}.jsonl`;
}

interface RunRecordEntry {
  type: string;
  [key: string]: unknown;
}

async function readRunRecord(workspacePath: string, recordPath: string): Promise<RunRecordEntry[]> {
  try {
    const content = await readFile(resolve(workspacePath, recordPath), "utf-8");
    return content
      .trim()
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RunRecordEntry);
  } catch {
    return [];
  }
}

function buildSlackDigest(entries: RunRecordEntry[]): string {
  const opportunities = entries.filter((e) => e.type === "opportunity");
  const metrics = entries.filter((e) => e.type === "metric");
  const parts: string[] = [":bird: *X Manager Digest*\n"];

  if (opportunities.length > 0) {
    parts.push(`*Engagement Opportunities* (${opportunities.length})`);
    for (const opp of opportunities) {
      const text = String(opp.text ?? "").substring(0, 100);
      parts.push(`- @${opp.authorHandle}: "${text}" - ${opp.reason}`);
    }
    parts.push("");
  } else {
    parts.push("*Engagement Opportunities*: None found.\n");
  }

  if (metrics.length > 0) {
    parts.push(`*Recent Post Performance* (${metrics.length})`);
    for (const m of metrics) {
      const text = String(m.postText ?? "Post").substring(0, 80);
      const stats = [
        m.impressions ? `${m.impressions} views` : null,
        m.likes ? `${m.likes} likes` : null,
        m.replies ? `${m.replies} replies` : null,
      ]
        .filter(Boolean)
        .join(", ");
      parts.push(`- ${text}: ${stats}`);
    }
  }

  return parts.join("\n");
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { slackChannel } = body as { slackChannel?: string };

  if (await isRunActive("xmanager")) {
    return NextResponse.json(
      { error: "An X Manager run is already in progress" },
      { status: 409 }
    );
  }

  await setActiveRun("xmanager", 1800); // 30 min for browser workflows

  try {
    // Read config from the xmanager agent's config dir
    const xUsername = (await readConfigFile("xmanager", "x_username.txt")).trim();
    if (!xUsername) {
      return NextResponse.json(
        { error: "X username not configured. Add workspace/xmanager/config/x_username.txt" },
        { status: 400 }
      );
    }

    const areasOfInterest = await readConfigFile("xmanager", "areas_of_interest.md");
    const engagementCriteria = await readConfigFile("xmanager", "engagement_criteria.md");

    // Build run record path and initialize
    const runRecordPath = buildRunRecordPath();
    const feedScanWorkspace = resolve(WORKSPACE_ROOT, "xmanager");
    const fullRecordPath = resolve(feedScanWorkspace, runRecordPath);
    await mkdir(dirname(fullRecordPath), { recursive: true });
    await writeFile(fullRecordPath, "");

    const lookbackHours = "12";
    const launcher = getLauncher();

    // Sub-task 1: Feed Scan
    console.log("[XManager] Running feed scan...");
    const feedResult = await launcher.launch({
      agentId: "xmanager",
      prompt: "/feed-scan",
      context: { xUsername, areasOfInterest, engagementCriteria, runRecordPath, lookbackHours },
    });
    if (feedResult.error) {
      console.error("[XManager] Feed scan error:", feedResult.error);
    }

    // Sub-task 2: Metrics Check
    console.log("[XManager] Running metrics check...");
    const metricsResult = await launcher.launch({
      agentId: "xmanager",
      prompt: "/metrics-check",
      context: { xUsername, runRecordPath, lookbackHours: "24" },
    });
    if (metricsResult.error) {
      console.error("[XManager] Metrics check error:", metricsResult.error);
    }

    // Aggregate results
    const entries = await readRunRecord(feedScanWorkspace, runRecordPath);
    const digest = buildSlackDigest(entries);

    // Write summary
    const summaryPath = runRecordPath.replace(".jsonl", "-summary.json");
    await writeFile(
      resolve(feedScanWorkspace, summaryPath),
      JSON.stringify({ timestamp: new Date().toISOString(), entries, digest }, null, 2)
    );

    // Post to Slack
    if (slackChannel && isSlackConfigured()) {
      try {
        await sendMessage(slackChannel, digest);
      } catch (err) {
        console.error("[XManager] Failed to post to Slack:", err);
      }
    }

    // Schedule next run (60 min)
    if (process.env.NODE_ENV !== "development") {
      try {
        await scheduleRun("xmanager", new Date(Date.now() + 60 * 60 * 1000));
      } catch (err) {
        console.error("[XManager] Failed to schedule next run:", err);
      }
    }

    return NextResponse.json({
      success: true,
      digest,
      opportunitiesFound: entries.filter((e) => e.type === "opportunity").length,
      metricsFound: entries.filter((e) => e.type === "metric").length,
      runRecordPath,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[XManager] Execution failed:", error);
    return NextResponse.json({ success: false, error }, { status: 500 });
  } finally {
    await clearActiveRun("xmanager");
  }
}
