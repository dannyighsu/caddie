/**
 * X Manager Execution Service
 *
 * Orchestrates sequential execution of feed scan and metrics check skills
 * via the Agent Runtime, aggregates results, and generates the Slack digest.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import type { AgentRuntime } from "../agents/runtime";
import {
  XMANAGER_SUBTASK_OUTPUT_SCHEMA,
  type XManagerSubTaskOutput,
} from "../agents/schemas";
import { renderFeedScanPrompt } from "../agents/skills/x-feed-scan";
import { renderMetricsCheckPrompt } from "../agents/skills/x-metrics-check";
import {
  clearXManagerRunActive,
  getLastXManagerRun,
  isXManagerRunActive,
  scheduleXManagerRun,
  setXManagerRunActive,
  setXManagerRunState,
} from "../clients/xmanager-redis-client";
import { getAppConfig } from "../config/app-config";
import { getXManagerConfig } from "../db/settings-repository";

export interface XManagerRunResult {
  success: boolean;
  slackMessage?: string;
  runRecord?: RunRecord;
  error?: string;
  nextRunTime?: Date;
}

interface RunRecordOpportunity {
  author: string;
  authorHandle: string;
  text: string;
  link: string;
  reason: string;
}

interface RunRecordMetric {
  postLink: string;
  postText: string;
  impressions?: number;
  likes?: number;
  replies?: number;
  retweets?: number;
  engagementRate?: number;
}

interface RunRecord {
  timestamp: string;
  opportunitiesFound: RunRecordOpportunity[];
  performanceMetrics: RunRecordMetric[];
  summary: string;
}

export class XManagerExecutionService {
  private runtime: AgentRuntime;

  constructor(runtime: AgentRuntime) {
    this.runtime = runtime;
  }

  private getWorkspaceDir(userId: string): string {
    const config = getAppConfig();
    const workspaceRoot =
      config.WORKSPACE_ROOT ?? resolve(process.cwd(), "workspace");
    return resolve(workspaceRoot, userId, "xmanager");
  }

  // ============================================================================
  // Configuration reading (from local workspace files)
  // ============================================================================

  private async readWorkspaceFile(
    workspaceDir: string,
    relativePath: string
  ): Promise<string> {
    try {
      const fullPath = resolve(workspaceDir, relativePath);
      return await readFile(fullPath, "utf-8");
    } catch {
      return "";
    }
  }

  // ============================================================================
  // Run Record Management
  // ============================================================================

  private buildRunRecordPath(): string {
    const now = new Date();
    const pstDate = new Date(
      now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
    );

    const year = pstDate.getFullYear();
    const month = String(pstDate.getMonth() + 1).padStart(2, "0");
    const day = String(pstDate.getDate());
    const dayName = pstDate
      .toLocaleDateString("en-US", { weekday: "long" })
      .toLowerCase();

    const timestamp = now.toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const filename = `run-record-${timestamp}.jsonl`;

    return `runs/${year}-${month}/${day}_${dayName}/${filename}`;
  }

  private async initRunRecordFile(
    workspaceDir: string,
    runRecordPath: string
  ): Promise<void> {
    const fullPath = resolve(workspaceDir, runRecordPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, "");
    console.log(`[XManager] Initialized empty run record: ${runRecordPath}`);
  }

  private async readRunRecord(
    workspaceDir: string,
    runRecordPath: string
  ): Promise<RunRecord> {
    const fullPath = resolve(workspaceDir, runRecordPath);
    let content: string;
    try {
      content = await readFile(fullPath, "utf-8");
    } catch {
      content = "";
    }

    const lines = content.trim().split("\n").filter((l) => l.trim());
    console.log(`[XManager] Read ${lines.length} lines from ${runRecordPath}`);

    const record: RunRecord = {
      timestamp: new Date().toISOString(),
      opportunitiesFound: [],
      performanceMetrics: [],
      summary: "",
    };

    for (const line of lines) {
      try {
        const item = JSON.parse(line);
        if (item.type === "opportunity") {
          record.opportunitiesFound.push({
            author: item.author,
            authorHandle: item.authorHandle,
            text: item.text,
            link: item.link,
            reason: item.reason,
          });
        } else if (item.type === "metric") {
          record.performanceMetrics.push({
            postLink: item.postLink,
            postText: item.postText,
            impressions: item.impressions,
            likes: item.likes,
            replies: item.replies,
            retweets: item.retweets,
            engagementRate: item.engagementRate,
          });
        }
      } catch (parseErr) {
        console.error(`[XManager] Failed to parse JSONL line: ${line}`, parseErr);
      }
    }

    console.log(
      `[XManager] Parsed: ${record.opportunitiesFound.length} opportunities, ${record.performanceMetrics.length} metrics`
    );

    return record;
  }

  private buildSlackMessage(record: RunRecord): string {
    const parts: string[] = [":bird: *X Manager Digest*\n"];

    if (record.opportunitiesFound.length > 0) {
      parts.push(`*Engagement Opportunities* (${record.opportunitiesFound.length})`);
      for (const opp of record.opportunitiesFound) {
        const text =
          opp.text.length > 100 ? opp.text.substring(0, 100) + "..." : opp.text;
        parts.push(
          `- [@${opp.authorHandle}](${opp.link}): "${text}" - ${opp.reason}`
        );
      }
      parts.push("");
    } else {
      parts.push("*Engagement Opportunities*: No high-quality opportunities found.\n");
    }

    if (record.performanceMetrics.length > 0) {
      parts.push(`*Recent Post Performance* (${record.performanceMetrics.length})`);
      for (const post of record.performanceMetrics) {
        const text = post.postText
          ? post.postText.length > 80
            ? post.postText.substring(0, 80) + "..."
            : post.postText
          : "Post";
        const metrics = [
          post.impressions ? `${post.impressions} views` : null,
          post.likes ? `${post.likes} likes` : null,
          post.replies ? `${post.replies} replies` : null,
        ]
          .filter(Boolean)
          .join(", ");
        parts.push(`- [${text}](${post.postLink}): ${metrics}`);
      }
      parts.push("");
    }

    return parts.join("\n");
  }

  // ============================================================================
  // Main Execution
  // ============================================================================

  async executeRun(userId: string = "default"): Promise<XManagerRunResult> {
    const appConfig = getAppConfig();

    const xManagerConfig = await getXManagerConfig();
    if (!xManagerConfig?.xUsername) {
      return {
        success: false,
        error: "X Manager is not configured. Please set your X username in Settings.",
      };
    }

    if (await isXManagerRunActive(userId)) {
      return {
        success: false,
        error: "An X Manager run is already in progress for this user",
      };
    }

    await setXManagerRunActive(userId);
    const workspaceDir = this.getWorkspaceDir(userId);

    try {
      // Load configuration from workspace files
      const [_lastRunState, areasOfInterest, engagementCriteria] =
        await Promise.all([
          getLastXManagerRun(userId),
          this.readWorkspaceFile(workspaceDir, "config/areas_of_interest.md"),
          this.readWorkspaceFile(workspaceDir, "config/engagement_criteria.md"),
        ]);

      console.log("[XManager] Starting execution...");
      console.log("[XManager] X Username:", xManagerConfig.xUsername);

      // Generate run record path and initialize
      const runRecordPath = this.buildRunRecordPath();
      console.log(`[XManager] Using run record: ${runRecordPath}`);
      await this.initRunRecordFile(workspaceDir, runRecordPath);

      // ---- Sub-task 1: Feed Scan ----
      console.log("[XManager] [1/2] Running feed scanner...");
      try {
        const feedScanPrompt = renderFeedScanPrompt({
          xUsername: xManagerConfig.xUsername,
          areasOfInterest,
          engagementCriteria,
          runRecordPath,
        });

        const feedResult = await this.runtime.execute({
          prompt: feedScanPrompt,
          outputSchema: XMANAGER_SUBTASK_OUTPUT_SCHEMA,
          maxTurns: 20,
          workingDirectory: workspaceDir,
          enableChrome: true,
        });

        if (feedResult.error) {
          console.error("[XManager] Feed scanner error:", feedResult.error);
        } else {
          const output = feedResult.output as unknown as XManagerSubTaskOutput;
          console.log(`[XManager] Feed scanner: ${output?.summary ?? "completed"}`);
        }
      } catch (err) {
        console.error("[XManager] Feed scanner error:", (err as Error).message);
      }

      // ---- Sub-task 2: Metrics Check ----
      console.log("[XManager] [2/2] Running metrics checker...");
      try {
        const metricsPrompt = renderMetricsCheckPrompt({
          xUsername: xManagerConfig.xUsername,
          runRecordPath,
          lookbackHours: 24,
        });

        const metricsResult = await this.runtime.execute({
          prompt: metricsPrompt,
          outputSchema: XMANAGER_SUBTASK_OUTPUT_SCHEMA,
          maxTurns: 15,
          workingDirectory: workspaceDir,
          enableChrome: true,
        });

        if (metricsResult.error) {
          console.error("[XManager] Metrics checker error:", metricsResult.error);
        } else {
          const output = metricsResult.output as unknown as XManagerSubTaskOutput;
          console.log(`[XManager] Metrics checker: ${output?.summary ?? "completed"}`);
        }
      } catch (err) {
        console.error("[XManager] Metrics checker error:", (err as Error).message);
      }

      // ---- Finalize ----
      console.log("[XManager] All sub-tasks completed. Reading final run record...");
      const runRecord = await this.readRunRecord(workspaceDir, runRecordPath);
      runRecord.timestamp = new Date().toISOString();
      runRecord.summary = `Found ${runRecord.opportunitiesFound.length} opportunities, ${runRecord.performanceMetrics.length} metrics`;

      // Write finalized summary to a separate file (Invariant 4: run record JSONL is immutable)
      const summaryPath = runRecordPath.replace(".jsonl", "-summary.json");
      const summaryFullPath = resolve(workspaceDir, summaryPath);
      await writeFile(summaryFullPath, JSON.stringify(runRecord, null, 2));

      const slackMessage = this.buildSlackMessage(runRecord);

      // Update run state
      await setXManagerRunState(userId, {
        userId,
        lastRunTime: Date.now(),
        lastRunSummary: runRecord.summary,
      });

      // Schedule next run (production only)
      let nextRunTime: Date | undefined;
      if (!appConfig.isDevelopment) {
        const nextRunMinutes = 60;
        nextRunTime = new Date(Date.now() + nextRunMinutes * 60 * 1000);
        await scheduleXManagerRun(userId, nextRunTime, {
          lastRunSummary: runRecord.summary,
        });
        console.log(`[XManager] Scheduled next run at ${nextRunTime.toISOString()}`);
      }

      console.log("[XManager] Execution completed successfully");

      return {
        success: true,
        slackMessage,
        runRecord,
        nextRunTime,
      };
    } catch (error) {
      console.error("[XManager] Execution error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    } finally {
      await clearXManagerRunActive(userId);
    }
  }
}

// Singleton
let instance: XManagerExecutionService | null = null;

export function getXManagerExecutionService(): XManagerExecutionService {
  if (!instance) {
    const { createBrowserRuntime } = require("../agents/runtimes/factory");
    instance = new XManagerExecutionService(createBrowserRuntime());
  }
  return instance;
}
