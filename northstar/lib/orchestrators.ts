/**
 * Agent Orchestrators
 *
 * Agent-specific execution logic that goes beyond a simple launcher.launch().
 * Called by the gateway (internal API) when an agent needs orchestration.
 *
 * Agents without an orchestrator just launch directly.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { getLauncher } from "./harness";
import { isRunActive, setActiveRun, clearActiveRun, scheduleOneShot } from "./redis";
import { sendMessage, isSlackConfigured } from "./slack";
import {
  createConversation,
  getConversation,
  appendMessages,
  updateSessionId,
  getSetting,
  type Message,
} from "./db";
import {
  createTraceId,
  createTrace,
  completeTrace,
  getTraceUrl,
  isTracingEnabled,
} from "./tracing";

import { workspaceRoot as WORKSPACE_ROOT } from "./harness";

// --- Registry ---

type Orchestrator = (params: OrchestratorParams) => Promise<Record<string, unknown>>;

export interface OrchestratorParams {
  prompt?: string;
  conversationId?: string;
  slackChannel?: string;
  context?: Record<string, string>;
  /** Skip Slack posting (caller handles it, e.g., Slack handler replies in thread). */
  skipSlack?: boolean;
}

const orchestrators: Record<string, Orchestrator> = {
  "buri": runCheckin,
  "buri:xmanager": runXManager,
};

/**
 * Get the orchestrator for an agent+profile combination.
 * Checks for "agentId:profile" first, then falls back to "agentId".
 */
export function getOrchestrator(agentId: string, profile?: string): Orchestrator | null {
  if (profile) {
    const specific = orchestrators[`${agentId}:${profile}`];
    if (specific) return specific;
  }
  return orchestrators[agentId] ?? null;
}

// --- Helpers ---

async function resolveSlackChannel(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  const defaultChannel = await getSetting<{ channelId: string }>("default_slack_channel");
  return defaultChannel?.channelId;
}

async function readConfigFile(agentId: string, filename: string): Promise<string> {
  try {
    return await readFile(
      resolve(WORKSPACE_ROOT, agentId, "config", filename),
      "utf-8"
    );
  } catch {
    return "";
  }
}

function currentTimePST(): string {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

// --- Check-In Orchestrator ---

async function runCheckin(params: OrchestratorParams): Promise<Record<string, unknown>> {
  const traceId = createTraceId();
  await createTrace(traceId, "buri", { trigger: "orchestrator" });

  const slackChannel = await resolveSlackChannel(params.slackChannel);

  if (await isRunActive("buri")) {
    return { success: false, error: "A check-in is already in progress" };
  }

  await setActiveRun("buri");

  try {
    let conversation;
    let sessionId: string | undefined;

    if (params.conversationId) {
      conversation = await getConversation(params.conversationId);
      if (!conversation) return { success: false, error: "Conversation not found" };
      sessionId = conversation.session_id ?? undefined;
    } else {
      conversation = await createConversation("buri", "Check-in");
    }

    const prompt = params.prompt ?? "Conduct a check-in.";
    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: "buri",
      prompt,
      sessionId,
      context: { currentTime: currentTimePST() },
      additionalEnv: { NORTHSTAR_TRACE_ID: traceId },
    });

    const now = new Date().toISOString();
    const newMessages: Message[] = [
      { role: "user", content: prompt, timestamp: now },
    ];
    if (result.rawText) {
      newMessages.push({
        role: "assistant",
        content: result.rawText,
        timestamp: new Date().toISOString(),
      });
    }
    await appendMessages(conversation.id, newMessages);

    if (result.sessionId) {
      await updateSessionId(conversation.id, result.sessionId);
    }

    // Post to Slack (unless caller handles it, e.g., Slack thread reply)
    if (!params.skipSlack && slackChannel && isSlackConfigured() && result.rawText) {
      try {
        const traceLink = isTracingEnabled() ? `\n<${getTraceUrl(traceId)}|View trace>` : "";
        await sendMessage(slackChannel, result.rawText + traceLink);
      } catch (err) {
        console.error("[Check-in] Failed to post to Slack:", err);
      }
    }

    // Schedule next check-in
    const nextMinutes = (result.output?.nextCheckInTime as number) ?? 120;
    const nextTime = new Date(Date.now() + nextMinutes * 60 * 1000);
    try {
      await scheduleOneShot("buri", nextTime, { description: "Next check-in" });
    } catch (err) {
      console.error("[Check-in] Failed to schedule next run:", err);
    }

    const runResult = {
      success: result.success,
      conversationId: conversation.id,
      sessionId: result.sessionId,
      rawText: result.rawText,
      nextCheckIn: nextTime.toISOString(),
      traceUrl: isTracingEnabled() ? getTraceUrl(traceId) : undefined,
      error: result.error,
    };

    await completeTrace(traceId, runResult);
    return runResult;
  } finally {
    await clearActiveRun("buri");
  }
}

// --- X Manager Orchestrator ---

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

async function runXManager(params: OrchestratorParams): Promise<Record<string, unknown>> {
  const traceId = createTraceId();
  await createTrace(traceId, "xmanager", { trigger: "orchestrator" });

  const slackChannel = await resolveSlackChannel(params.slackChannel);

  if (await isRunActive("xmanager")) {
    return { success: false, error: "An X Manager run is already in progress" };
  }

  await setActiveRun("xmanager", 1800);

  try {
    const xUsername = (await readConfigFile("buri", "x_username.txt")).trim();
    if (!xUsername) {
      return { success: false, error: "X username not configured. Add workspace/buri/config/x_username.txt" };
    }

    const areasOfInterest = await readConfigFile("buri", "areas_of_interest.md");
    const engagementCriteria = await readConfigFile("buri", "engagement_criteria.md");

    const runRecordPath = buildRunRecordPath();
    const xmanagerWorkspace = resolve(WORKSPACE_ROOT, "buri");
    const fullRecordPath = resolve(xmanagerWorkspace, runRecordPath);
    await mkdir(dirname(fullRecordPath), { recursive: true });
    await writeFile(fullRecordPath, "");

    const lookbackHours = "12";
    const launcher = getLauncher();

    // Feed scan
    console.log("[XManager] Running feed scan...");
    const feedResult = await launcher.launch({
      agentId: "buri", profile: "xmanager",
      prompt: "/feed-scan",
      context: { xUsername, areasOfInterest, engagementCriteria, runRecordPath, lookbackHours },
      additionalEnv: { NORTHSTAR_TRACE_ID: traceId },
    });
    if (feedResult.error) {
      console.error("[XManager] Feed scan error:", feedResult.error);
    }

    // Metrics check
    console.log("[XManager] Running metrics check...");
    const metricsResult = await launcher.launch({
      agentId: "buri", profile: "xmanager",
      prompt: "/metrics-check",
      context: { xUsername, runRecordPath, lookbackHours: "24" },
      additionalEnv: { NORTHSTAR_TRACE_ID: traceId },
    });
    if (metricsResult.error) {
      console.error("[XManager] Metrics check error:", metricsResult.error);
    }

    // Aggregate
    const entries = await readRunRecord(xmanagerWorkspace, runRecordPath);
    const digest = buildSlackDigest(entries);

    const summaryPath = runRecordPath.replace(".jsonl", "-summary.json");
    await writeFile(
      resolve(xmanagerWorkspace, summaryPath),
      JSON.stringify({ timestamp: new Date().toISOString(), entries, digest }, null, 2)
    );

    // Post to Slack (unless caller handles it)
    if (!params.skipSlack && slackChannel && isSlackConfigured()) {
      try {
        const traceLink = isTracingEnabled() ? `\n<${getTraceUrl(traceId)}|View trace>` : "";
        await sendMessage(slackChannel, digest + traceLink);
      } catch (err) {
        console.error("[XManager] Failed to post to Slack:", err);
      }
    }

    // Schedule next run (production only)
    if (process.env.NODE_ENV !== "development") {
      try {
        await scheduleOneShot("buri", new Date(Date.now() + 60 * 60 * 1000), {
          profile: "xmanager",
          description: "Next X Manager run",
        });
      } catch (err) {
        console.error("[XManager] Failed to schedule next run:", err);
      }
    }

    const runResult = {
      success: true,
      digest,
      opportunitiesFound: entries.filter((e) => e.type === "opportunity").length,
      metricsFound: entries.filter((e) => e.type === "metric").length,
      runRecordPath,
      traceUrl: isTracingEnabled() ? getTraceUrl(traceId) : undefined,
    };

    await completeTrace(traceId, runResult);
    return runResult;
  } finally {
    await clearActiveRun("xmanager");
  }
}
