/**
 * Agent Orchestrators
 *
 * Agent-specific execution logic that goes beyond a simple launcher.launch().
 * Called by the gateway (internal API) when an agent needs orchestration.
 *
 * Agents without an orchestrator just launch directly.
 */

import { resolve } from "path";
import { getLauncher, resolversDir } from "./harness";
import { runResolvers } from "@agints/harness";
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

// --- Context Enrichers ---
//
// Lightweight context providers used by the shared messaging path.
// Unlike full orchestrators, these only gather additional context
// for the agent launch — conversation management stays in the caller.

type ContextEnricher = () => Promise<Record<string, string>>;

const contextEnrichers: Record<string, ContextEnricher> = {
  "buri": async () => {
    return runResolvers(["google-calendar"], resolversDir, {
      workingDirectory: resolve(WORKSPACE_ROOT, "buri"),
      harnessRoot: resolve(resolversDir, ".."),
    });
  },
};

/**
 * Get a context enricher for an agent+profile combination.
 * Returns additional context to merge into the agent launch,
 * without taking over the full execution lifecycle.
 */
export function getContextEnricher(agentId: string, profile?: string): ContextEnricher | null {
  if (profile) {
    const specific = contextEnrichers[`${agentId}:${profile}`];
    if (specific) return specific;
  }
  return contextEnrichers[agentId] ?? null;
}

// --- Helpers ---

async function resolveSlackChannel(explicit?: string): Promise<string | undefined> {
  if (explicit) return explicit;
  const defaultChannel = await getSetting<{ channelId: string }>("default_slack_channel");
  return defaultChannel?.channelId;
}

export function currentTimePST(): string {
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

    // Run calendar resolver specifically for check-in workflow
    const calendarContext = await contextEnrichers["buri"]();

    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: "buri",
      prompt,
      sessionId,
      context: { currentTime: currentTimePST(), ...calendarContext },
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

