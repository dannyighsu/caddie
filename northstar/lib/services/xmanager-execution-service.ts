import { StepResult, ToolSet } from "ai";
import { UnifiedAgent } from "../agents/unified-agent";
import { getFeedScanPrompt } from "../agents/skills/x-feed-scan";
import { getMetricsCheckPrompt } from "../agents/skills/x-metrics-check";
import {
  createBrowserToolSet,
  createWebSearchToolSet,
  createWorkspaceToolSet,
  createXManagerSubTaskFinishToolSet,
  mergeToolSets,
  type ToolSetHandle,
} from "../ai/tool-sets";
import { createBrowserUseMCPClient } from "../ai/browser-use-mcp-client";
import { createBackend } from "../ai/filesystems";
import { getModel } from "../ai/openrouter-client";
import type { XManagerFinishToolResult } from "../ai/xmanager-tools";
import {
  clearXManagerRunActive,
  getLastXManagerRun,
  isXManagerRunActive,
  scheduleXManagerRun,
  setXManagerRunActive,
  setXManagerRunState
} from "../clients/xmanager-redis-client";
import { getAppConfig } from "../config/app-config";
import { getXManagerConfig } from "../db/settings-repository";
import {
  flushLangfuse,
  generateSessionId,
  logAgentStep,
  withLangfuseSession,
} from "../tracing/langfuse";
import { Experimental_Agent as LegacyAgent, stepCountIs } from "ai";

/**
 * Create a scoped step logger for an agent.
 * Each agent gets its own independent step counter.
 */
function createStepLogger(agentName: string) {
  let stepCounter = 0;

  return function logStepResult<T extends ToolSet>(stepResult: StepResult<T>): void {
    stepCounter++;
    console.log(
      `\n[XManager/${agentName}] Step ${stepCounter} | Finish Reason: ${stepResult.finishReason}`
    );

    if (stepResult.text) {
      const textPreview =
        stepResult.text.length > 200
          ? stepResult.text.substring(0, 200) + "..."
          : stepResult.text;
      console.log(`  Text: ${textPreview}`);
    }

    if (stepResult.toolCalls.length > 0) {
      for (const call of stepResult.toolCalls) {
        console.log(`  Tool: ${call.toolName}`);
      }
    }

    // Log to Langfuse with full details (reasoning, tool calls, results)
    logAgentStep(stepCounter, stepResult);
  };
}

export interface XManagerRunResult {
  success: boolean;
  slackMessage?: string;
  runRecord?: XManagerFinishToolResult;
  error?: string;
  nextRunTime?: Date;
}

// Insights file paths within xmanager workspace
const REPLY_STRATEGY_PATH = "insights/reply_strategy.txt";
const PERFORMANCE_LOG_PATH = "insights/performance_log.txt";

export class XManagerExecutionService {
  /**
   * Read insights files from the filesystem
   * Returns empty strings if files don't exist
   */
  private async readInsightsFiles(userId: string): Promise<{
    replyStrategy: string;
    performanceLog: string;
  }> {
    const backend = createBackend(userId);

    let replyStrategy = "";
    let performanceLog = "";

    try {
      const scope = backend.scope("xmanager");

      try {
        const content = await scope.read(REPLY_STRATEGY_PATH);
        replyStrategy = content.toString();
        console.log("[XManager] Loaded reply_strategy.txt");
      } catch {
        console.log("[XManager] No existing reply_strategy.txt found:");
      }

      try {
        const content = await scope.read(PERFORMANCE_LOG_PATH);
        performanceLog = content.toString();
        console.log("[XManager] Loaded performance_log.txt");
      } catch {
        console.log("[XManager] No existing performance_log.txt found");
      }
    } finally {
      await backend.destroy();
    }

    return { replyStrategy, performanceLog };
  }

  /**
   * Read the areas of interest markdown file from the filesystem
   * Returns empty string if file doesn't exist (will be created by API route)
   */
  private async readAreasOfInterest(userId: string): Promise<string> {
    const backend = createBackend(userId);

    try {
      const scope = backend.scope("xmanager");
      const content = await scope.read("config/areas_of_interest.md");
      console.log("[XManager] Loaded areas_of_interest.md");
      return content.toString();
    } catch {
      console.log("[XManager] No existing areas_of_interest.md found");
      return "";
    } finally {
      await backend.destroy();
    }
  }

  /**
   * Read the engagement criteria markdown file from the filesystem
   * Returns empty string if file doesn't exist (will be created by API route)
   */
  private async readEngagementCriteria(userId: string): Promise<string> {
    const backend = createBackend(userId);

    try {
      const scope = backend.scope("xmanager");
      const content = await scope.read("config/engagement_criteria.md");
      console.log("[XManager] Loaded engagement_criteria.md");
      return content.toString();
    } catch {
      console.log("[XManager] No existing engagement_criteria.md found");
      return "";
    } finally {
      await backend.destroy();
    }
  }


  /**
   * Open browser and navigate to X for manual login.
   * The user can log in manually and the session will be persisted.
   */
  async openLoginBrowser(): Promise<{ success: boolean; error?: string }> {
    console.log("[XManager] Opening browser for X login...");

    let browserClient: Awaited<ReturnType<typeof createBrowserUseMCPClient>> | null = null;

    try {
      // Get user's model preference
      const xManagerConfig = await getXManagerConfig();
      const model = getModel(xManagerConfig?.modelId);
      browserClient = await createBrowserUseMCPClient();

      if (!browserClient) {
        return {
          success: false,
          error: "Browser tools not available. Check browser-use configuration.",
        };
      }

      const browserTools = await browserClient.tools();

      if (Object.keys(browserTools).length === 0) {
        return {
          success: false,
          error: "Browser tools not available. Check browser-use configuration.",
        };
      }

      // Use the agent to navigate to X and wait for login
      const agent = new LegacyAgent({
        model,
        tools: browserTools as ToolSet,
        stopWhen: [stepCountIs(20)],
      });

      const result = await agent.generate({
        prompt: `Navigate to x.com (Twitter) and wait for the user to log in manually.

Instructions:
1. First, navigate to https://x.com
2. Check if the user is already logged in (look for the home feed or profile icon)
3. If already logged in, report success immediately
4. If not logged in, wait in 10-second intervals for up to 2 minutes for the user to complete the login process
5. After each wait, check if the login was successful by looking for indicators like the home feed
6. Once logged in (or after timeout), report the result

The user will manually enter their credentials in the browser window that opens.`,
      });

      console.log("[XManager] Login flow completed:", result.text);

      return {
        success: true,
      };
    } catch (error) {
      console.error("[XManager] Login error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    } finally {
      // Always close the browser client to clean up the browser process
      if (browserClient) {
        console.log("[XManager] Closing browser client...");
        await browserClient.close();
      }
    }
  }

  // ============================================================================
  // Run Record Management (absorbed from orchestrator-agent.ts)
  // ============================================================================

  /**
   * Build run record path with timestamp for data lineage.
   * Format: runs/YYYY-MM/DD_dayname/run-record-YYYY-MM-DDTHH-MM-SS.jsonl
   */
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

  /**
   * Initialize the run record file (create directory and empty file).
   */
  private async initRunRecordFile(
    userId: string,
    runRecordPath: string
  ): Promise<void> {
    const dirPath = runRecordPath.substring(0, runRecordPath.lastIndexOf("/"));
    if (!dirPath) return;

    console.log(`[XManager] Ensuring directory exists: ${dirPath}`);
    const backend = createBackend(userId);
    try {
      const scope = backend.scope("xmanager");
      await scope.mkdir(dirPath);
      console.log(`[XManager] Directory created/verified: ${dirPath}`);

      await scope.write(runRecordPath, "");
      console.log(`[XManager] Initialized empty run record file: ${runRecordPath}`);
    } catch (err) {
      console.error(`[XManager] Error creating run record file:`, err);
      throw new Error(`Failed to initialize run record file: ${err}`);
    } finally {
      await backend.destroy();
    }
  }

  /**
   * Read the run record from JSONL file.
   * Parses each line and groups by type into the appropriate arrays.
   */
  private async readRunRecord(
    userId: string,
    runRecordPath: string
  ): Promise<XManagerFinishToolResult["runRecord"]> {
    const backend = createBackend(userId);

    try {
      const scope = backend.scope("xmanager");
      const content = await scope.read(runRecordPath);

      const contentStr = content as string;
      const lines = contentStr.trim().split("\n").filter(line => line.trim());

      console.log(
        `[XManager] Read ${lines.length} lines from ${runRecordPath}`
      );

      // Initialize result structure
      const runRecord: XManagerFinishToolResult["runRecord"] = {
        timestamp: new Date().toISOString(),
        repliesFound: [],
        opportunitiesFound: [],
        performanceMetrics: [],
        summary: "",
      };

      // Parse each line and group by type
      for (const line of lines) {
        try {
          const item = JSON.parse(line);

          if (item.type === "reply") {
            runRecord.repliesFound.push({
              author: item.author,
              authorHandle: item.authorHandle,
              text: item.text,
              link: item.link,
              priority: item.priority,
              reason: item.reason,
            });
          } else if (item.type === "opportunity") {
            runRecord.opportunitiesFound.push({
              author: item.author,
              authorHandle: item.authorHandle,
              text: item.text,
              link: item.link,
              reason: item.reason,
            });
          } else if (item.type === "metric") {
            if (!runRecord.performanceMetrics) {
              runRecord.performanceMetrics = [];
            }
            runRecord.performanceMetrics.push({
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
          console.error(
            `[XManager] Failed to parse JSONL line: ${line}`,
            parseErr
          );
        }
      }

      console.log(
        `[XManager] Parsed: ${runRecord.repliesFound.length} replies, ${runRecord.opportunitiesFound.length} opportunities, ${runRecord.performanceMetrics?.length || 0} metrics`
      );

      return runRecord;
    } catch (err) {
      console.error(
        `[XManager] Failed to read run record from ${runRecordPath}:`,
        err
      );
      throw new Error(`Failed to read run record file: ${err}`);
    } finally {
      await backend.destroy();
    }
  }

  /**
   * Write the run record to the filesystem.
   */
  private async writeRunRecord(
    userId: string,
    runRecord: XManagerFinishToolResult["runRecord"],
    runRecordPath: string
  ): Promise<void> {
    const backend = createBackend(userId);

    try {
      const scope = backend.scope("xmanager");
      await scope.write(
        runRecordPath,
        JSON.stringify(runRecord, null, 2),
      );
      console.log(
        `[XManager] Wrote run record to ${runRecordPath}`
      );
    } catch (err) {
      console.error(
        `[XManager] Failed to write run record:`,
        err
      );
    } finally {
      await backend.destroy();
    }
  }

  /**
   * Build a summary from the run record.
   */
  private buildSummaryFromRunRecord(
    runRecord: XManagerFinishToolResult["runRecord"]
  ): string {
    const parts: string[] = [];

    parts.push(`Found ${runRecord.repliesFound?.length || 0} replies to review`);
    parts.push(
      `Found ${runRecord.opportunitiesFound?.length || 0} engagement opportunities`
    );

    if ((runRecord.performanceMetrics?.length || 0) > 0) {
      parts.push(
        `Analyzed ${runRecord.performanceMetrics?.length || 0} recent posts`
      );
    }

    return parts.join(". ");
  }

  /**
   * Build the Slack message from the run record.
   */
  private buildSlackMessageFromRunRecord(
    runRecord: XManagerFinishToolResult["runRecord"]
  ): string {
    const parts: string[] = [":bird: *X Manager Digest*\n"];

    // Engagement opportunities section
    const opportunitiesFound = runRecord.opportunitiesFound || [];
    if (opportunitiesFound.length > 0) {
      parts.push(
        `*Engagement Opportunities* (${opportunitiesFound.length})`
      );
      for (const opp of opportunitiesFound) {
        const text =
          opp.text.length > 100 ? opp.text.substring(0, 100) + "..." : opp.text;
        parts.push(
          `- [@${opp.authorHandle}](${opp.link}): "${text}" - ${opp.reason}`
        );
      }
      parts.push("");
    } else {
      parts.push(
        "*Engagement Opportunities*: No high-quality opportunities found.\n"
      );
    }

    // Performance metrics section
    const performanceMetrics = runRecord.performanceMetrics || [];
    if (performanceMetrics.length > 0) {
      parts.push(
        `*Recent Post Performance* (${performanceMetrics.length})`
      );
      for (const post of performanceMetrics) {
        const text = post.postText
          ? post.postText.length > 80
            ? post.postText.substring(0, 80) + "..."
            : post.postText
          : "Post";
        const metrics_str = [
          post.impressions ? `${post.impressions} views` : null,
          post.likes ? `${post.likes} likes` : null,
          post.replies ? `${post.replies} replies` : null,
        ]
          .filter(Boolean)
          .join(", ");
        parts.push(`- [${text}](${post.postLink}): ${metrics_str}`);
      }
      parts.push("");
    }

    return parts.join("\n");
  }

  /**
   * Update insights files based on the run results.
   *
   * This is a simplified version - in production, you might want to
   * use an LLM to intelligently update insights based on patterns.
   */
  private async updateInsights(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _runRecord: XManagerFinishToolResult["runRecord"]
  ): Promise<void> {
    // For now, just log that we'd update insights
    // In a full implementation, you'd analyze patterns and update files
    console.log(
      `[XManager] Would update insights files based on run results`
    );

    // TODO: Implement intelligent insights updates
    // This could involve reading existing insights, analyzing patterns,
    // and writing back updated insights using the constellation MCP tools
  }

  // ============================================================================
  // Main Execution
  // ============================================================================

  /**
   * Execute an X Manager run.
   *
   * Orchestrates sequential execution of feed scan and metrics check skills
   * with a shared browser instance, aggregates results, and generates the
   * Slack digest message.
   */
  async executeRun(userId: string = "default"): Promise<XManagerRunResult> {
    const appConfig = getAppConfig();

    // Load X Manager config from database
    const xManagerConfig = await getXManagerConfig();
    if (!xManagerConfig?.xUsername) {
      return {
        success: false,
        error: "X Manager is not configured. Please set your X username in Settings.",
      };
    }

    // Check if already running
    if (await isXManagerRunActive(userId)) {
      return {
        success: false,
        error: "An X Manager run is already in progress for this user",
      };
    }

    // Set active run lock
    await setXManagerRunActive(userId);

    // Generate session ID for this run
    const sessionId = generateSessionId("xmanager");

    const cleanup = {
      browserToolSet: null as ToolSetHandle | null,
      workspaceToolSet: null as ToolSetHandle | null,
      webSearchToolSet: null as ToolSetHandle | null,
    };

    try {
      // Wrap entire execution in Langfuse session context
      return await withLangfuseSession(
        { sessionId, agentType: "xmanager", runType: "scheduled" },
        async () => {
          // Read insights files, last run state, areas of interest, and engagement criteria in parallel
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const [_lastRunState, _insights, areasOfInterest, engagementCriteria] = await Promise.all([
            getLastXManagerRun(userId),
            this.readInsightsFiles(userId),
            this.readAreasOfInterest(userId),
            this.readEngagementCriteria(userId),
          ]);

          console.log("[XManager] Starting orchestrated execution...");
          console.log("[XManager] Session ID:", sessionId);
          console.log("[XManager] X Username:", xManagerConfig.xUsername);

          // Generate run record path and initialize file
          const runRecordPath = this.buildRunRecordPath();
          console.log(`[XManager] Using run record: ${runRecordPath}`);
          await this.initRunRecordFile(userId, runRecordPath);

          // Create tool sets: shared browser + workspace for run record writing
          console.log("[XManager] Initializing shared browser...");
          cleanup.browserToolSet = await createBrowserToolSet({
            profileId: appConfig.BROWSER_USE_PROFILE_ID,
          });
          console.log("[XManager] Shared browser initialized successfully");

          cleanup.workspaceToolSet = await createWorkspaceToolSet({
            userId,
            workspace: "xmanager",
          });

          // Web search tools for researching context during X Manager runs
          cleanup.webSearchToolSet = await createWebSearchToolSet();

          const finishToolSet = createXManagerSubTaskFinishToolSet();
          const subTaskTools = mergeToolSets(
            { tools: cleanup.browserToolSet.tools, close: async () => {} }, // Don't close browser between sub-tasks
            cleanup.workspaceToolSet,
            cleanup.webSearchToolSet,
            finishToolSet
          );

          // Create scoped step loggers for each sub-task
          const feedScannerStepLogger = createStepLogger("FeedScanner");
          const metricsCheckerStepLogger = createStepLogger("MetricsChecker");

          // ---- Sub-task 1: Feed Scan ----
          console.log("[XManager] [1/2] Running feed scanner...");
          try {
            const { compiled: feedScanPrompt, promptObject: feedScanPromptObject } =
              await getFeedScanPrompt({
                xUsername: xManagerConfig.xUsername,
                areasOfInterest,
                engagementCriteria,
                runRecordPath,
              });

            const feedScanAgent = new UnifiedAgent({
              sessionId,
              modelId: xManagerConfig.modelId,
              maxSteps: 20,
              onStepFinish: feedScannerStepLogger,
            });

            await feedScanAgent.execute("Begin your task.", {
              systemPrompt: feedScanPrompt,
              tools: subTaskTools.tools,
              langfusePromptObject: feedScanPromptObject,
              functionId: "xmanager-feed-scanner",
            });
          } catch (err) {
            console.error("[XManager] Feed scanner error:", (err as Error).message);
          }
          console.log("[XManager] Feed scanner complete");

          // ---- Sub-task 2: Metrics Check ----
          console.log("[XManager] [2/2] Running metrics checker...");
          try {
            const { compiled: metricsPrompt, promptObject: metricsPromptObject } =
              await getMetricsCheckPrompt({
                xUsername: xManagerConfig.xUsername,
                runRecordPath,
                lookbackHours: 24,
              });

            const metricsAgent = new UnifiedAgent({
              sessionId,
              modelId: xManagerConfig.modelId,
              maxSteps: 15,
              onStepFinish: metricsCheckerStepLogger,
            });

            await metricsAgent.execute("Begin your task.", {
              systemPrompt: metricsPrompt,
              tools: subTaskTools.tools,
              langfusePromptObject: metricsPromptObject,
              functionId: "xmanager-metrics-checker",
            });
          } catch (err) {
            console.error("[XManager] Metrics checker error:", (err as Error).message);
          }
          console.log("[XManager] Metrics checker complete");

          // ---- Finalize: Read results, build Slack message ----
          console.log("[XManager] All sub-tasks completed. Reading final run record...");
          const runRecord = await this.readRunRecord(userId, runRecordPath);

          // Update with final timestamp and summary
          runRecord.timestamp = new Date().toISOString();
          runRecord.summary = this.buildSummaryFromRunRecord(runRecord);

          // Write updated run record back
          await this.writeRunRecord(userId, runRecord, runRecordPath);

          // Update insights
          await this.updateInsights(runRecord);

          // Generate Slack message
          const slackMessage = this.buildSlackMessageFromRunRecord(runRecord);

          const finishResult: XManagerFinishToolResult = {
            slackMessage,
            runRecord,
            nextRunMinutes: 60,
          };

          // Update run state
          const summary = `Found ${runRecord.opportunitiesFound.length} opportunities, ${runRecord.performanceMetrics?.length || 0} metrics`;
          await setXManagerRunState(userId, {
            userId,
            lastRunTime: Date.now(),
            lastRunSummary: summary,
          });

          // Schedule next run (only in production)
          let nextRunTime: Date | undefined;
          if (!appConfig.isDevelopment) {
            nextRunTime = new Date(
              Date.now() + finishResult.nextRunMinutes * 60 * 1000
            );
            await scheduleXManagerRun(userId, nextRunTime, {
              lastRunSummary: summary,
            });
            console.log(
              `[XManager] Scheduled next run at ${nextRunTime.toISOString()}`
            );
          } else {
            console.log(
              "[XManager] Development mode - skipping automatic scheduling"
            );
          }

          console.log("[XManager] Execution completed successfully");

          return {
            success: true,
            slackMessage: finishResult.slackMessage,
            runRecord: finishResult,
            nextRunTime,
          };
        }
      );
    } catch (error) {
      console.error("[XManager] Execution error:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    } finally {
      // Clean up tool sets
      console.log("[XManager] Cleaning up resources...");
      if (cleanup.browserToolSet) {
        try {
          await cleanup.browserToolSet.close();
        } catch (err) {
          console.error("[XManager] Error closing browser tool set:", err);
        }
      }
      if (cleanup.workspaceToolSet) {
        try {
          await cleanup.workspaceToolSet.close();
        } catch (err) {
          console.error("[XManager] Error closing workspace tool set:", err);
        }
      }
      if (cleanup.webSearchToolSet) {
        try {
          await cleanup.webSearchToolSet.close();
        } catch (err) {
          console.error("[XManager] Error closing web search tool set:", err);
        }
      }
      console.log("[XManager] All cleanup complete");

      await clearXManagerRunActive(userId);
      // Flush traces before function returns
      await flushLangfuse();
    }
  }
}

// Singleton instance
let instance: XManagerExecutionService | null = null;

export function getXManagerExecutionService(): XManagerExecutionService {
  if (!instance) {
    instance = new XManagerExecutionService();
  }
  return instance;
}
