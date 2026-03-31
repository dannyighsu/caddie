/**
 * Slack Message Handler
 *
 * Processes inbound Slack messages received via Socket Mode.
 * Routes new threads to the appropriate agent via the classifier.
 * Continues existing threads with session resumption.
 *
 * This handler owns the Slack reply — orchestrators are told to skip
 * their own Slack posting via skipSlack: true.
 */

import { getLauncher } from "./harness";
import {
  createConversation,
  getConversationByExternalId,
  appendMessages,
  updateSessionId,
  type Message,
} from "./db";
import { replyInThread } from "./slack";
import { classifyMessage } from "./classifier";
import { getOrchestrator } from "./orchestrators";
import { createTraceId, createTrace, completeTrace, getTraceUrl, isTracingEnabled } from "./tracing";
import type { SlackMessageHandler } from "./slack";

export const handleSlackMessage: SlackMessageHandler = async ({
  text,
  channel,
  ts,
  threadTs,
}) => {
  const conversationThreadTs = threadTs ?? ts;
  const externalId = `slack:${channel}:${conversationThreadTs}`;

  // Create a trace for this interaction
  const traceId = createTraceId();
  await createTrace(traceId, "slack-message", { channel, text: text.substring(0, 100) });

  try {
    let conversation = await getConversationByExternalId(externalId);
    let sessionId: string | undefined;

    let profile: string | undefined;

    if (conversation) {
      sessionId = conversation.session_id ?? undefined;
      profile = conversation.profile ?? undefined;
    } else {
      const classification = await classifyMessage(text);
      console.log(
        `[Slack] Classified "${text.substring(0, 50)}..." as: ${classification.label} (${classification.confidence})`
      );

      profile = classification.profile;
      const title = text.length > 80 ? text.substring(0, 80) + "..." : text;
      conversation = await createConversation(
        classification.agentId,
        title,
        externalId,
        profile
      );

      await replyInThread(
        channel,
        conversationThreadTs,
        `_Routed to ${classification.label}_`
      );
    }

    // Execute agent — check for orchestrator, then fall back to direct launch
    const orchestrator = getOrchestrator(conversation.agent_id, profile);

    let rawText: string | undefined;
    let resultSessionId: string | undefined;
    let resultTraceUrl: string | undefined;

    if (orchestrator) {
      const result = await orchestrator({
        prompt: text,
        skipSlack: true,
      });
      rawText = result.rawText as string | undefined ?? result.digest as string | undefined;
      resultSessionId = result.sessionId as string | undefined;
      resultTraceUrl = result.traceUrl as string | undefined;
    } else {
      const launcher = getLauncher();
      const result = await launcher.launch({
        agentId: conversation.agent_id,
        profile,
        prompt: text,
        sessionId,
        context: {
          currentTime: new Date().toLocaleString("en-US", {
            timeZone: "America/Los_Angeles",
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          }),
        },
        additionalEnv: { NORTHSTAR_TRACE_ID: traceId },
      });
      rawText = result.rawText;
      resultSessionId = result.sessionId;
    }

    // Record messages
    const now = new Date().toISOString();
    const newMessages: Message[] = [
      { role: "user", content: text, timestamp: now },
    ];
    if (rawText) {
      newMessages.push({
        role: "assistant",
        content: rawText,
        timestamp: new Date().toISOString(),
      });
    }
    await appendMessages(conversation.id, newMessages);

    if (resultSessionId) {
      await updateSessionId(conversation.id, resultSessionId);
    }

    // Reply in thread — always include trace link
    if (rawText) {
      const traceUrl = resultTraceUrl ?? (isTracingEnabled() ? getTraceUrl(traceId) : null);
      const traceLink = traceUrl ? `\n<${traceUrl}|View trace>` : "";
      await replyInThread(channel, conversationThreadTs, rawText + traceLink);
    }

    await completeTrace(traceId, { agentId: conversation.agent_id, success: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err) || "Unknown error";
    console.error("[Slack] Handler error:", error);
    if (err instanceof Error && err.stack) {
      console.error("[Slack] Stack:", err.stack);
    }

    await completeTrace(traceId, { success: false, error });

    try {
      await replyInThread(
        channel,
        conversationThreadTs,
        `Sorry, something went wrong: ${error}`
      );
    } catch {
      // Best effort
    }
  }
};
