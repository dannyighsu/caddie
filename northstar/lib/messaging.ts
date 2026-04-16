/**
 * Shared Messaging Handler
 *
 * Channel-agnostic logic for processing inbound messages from any platform
 * (Slack, Telegram, email, etc.). Handles classification, agent execution,
 * conversation persistence, and tracing.
 *
 * Channel-specific adapters call handleInboundMessage() with a reply function
 * and channel-specific metadata.
 */

import { getLauncher } from "./harness";
import {
  createConversation,
  getConversationByExternalId,
  appendMessages,
  updateSessionId,
  type Message,
} from "./db";
import { classifyMessage } from "./classifier";
import { currentTimePST } from "./helpers";
import {
  createTraceId,
  createTrace,
  completeTrace,
  getTraceUrl,
  isTracingEnabled,
} from "./tracing";

export interface InboundMessageParams {
  /** The message text (already cleaned of mention markup, etc.) */
  text: string;
  /** Channel-specific external ID, e.g. "slack:C123:ts" or "telegram:chatId" */
  externalId: string;
  /** Channel name for tracing, e.g. "slack-message" or "telegram-message" */
  traceName: string;
  /** Trace metadata (channel-specific context) */
  traceMetadata?: Record<string, string>;
  /** Send a reply back to the originating channel */
  replyFn: (text: string) => Promise<void>;
  /** Optional: send a routing confirmation (e.g. "_Routed to Buri_") */
  routingConfirmFn?: (label: string) => Promise<void>;
  /** Optional: additional context to pass to the agent prompt */
  context?: Record<string, string>;
}

export interface InboundMessageResult {
  rawText?: string;
  sessionId?: string;
  conversationId: string;
  agentId: string;
  profile?: string;
}

/**
 * Process an inbound message from any channel.
 *
 * 1. Lookup or create conversation by external ID
 * 2. Classify new conversations to route to the right agent/profile
 * 3. Launch agent with session resumption
 * 4. Persist messages
 * 5. Reply via the provided replyFn
 */
export async function handleInboundMessage(
  params: InboundMessageParams
): Promise<InboundMessageResult> {
  const { text, externalId, traceName, traceMetadata, replyFn, routingConfirmFn, context } = params;

  const traceId = createTraceId();
  await createTrace(traceId, traceName, traceMetadata);

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
        `[Messaging] Classified "${text.substring(0, 50)}..." as: ${classification.label} (${classification.confidence})`
      );

      profile = classification.profile;
      const title = text.length > 80 ? text.substring(0, 80) + "..." : text;
      conversation = await createConversation(
        classification.agentId,
        title,
        externalId,
        profile
      );

      if (routingConfirmFn) {
        await routingConfirmFn(classification.label);
      }
    }

    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: conversation.agent_id,
      profile,
      prompt: text,
      sessionId,
      context: {
        currentTime: currentTimePST(),
        ...context,
      },
      additionalEnv: { NORTHSTAR_TRACE_ID: traceId },
    });

    const rawText = result.rawText;
    const resultSessionId = result.sessionId;

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

    // Reply
    if (rawText) {
      const traceUrl = isTracingEnabled() ? getTraceUrl(traceId) : null;
      const traceLink = traceUrl ? `\n${traceUrl}` : "";
      await replyFn(rawText + traceLink);
    }

    await completeTrace(traceId, { agentId: conversation.agent_id, success: true });

    return {
      rawText,
      sessionId: resultSessionId,
      conversationId: conversation.id,
      agentId: conversation.agent_id,
      profile,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err) || "Unknown error";
    console.error(`[Messaging] Handler error (${traceName}):`, error);
    if (err instanceof Error && err.stack) {
      console.error(`[Messaging] Stack:`, err.stack);
    }

    await completeTrace(traceId, { success: false, error });

    try {
      await replyFn(`Sorry, something went wrong: ${error}`);
    } catch {
      // Best effort
    }

    throw err;
  }
}
