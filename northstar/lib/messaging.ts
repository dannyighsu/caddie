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

/** A file attachment from any channel, already downloaded to the workspace. */
export interface Attachment {
  /** Absolute path to the downloaded file in the workspace artifacts directory */
  filePath: string;
  /** Original filename */
  fileName: string;
  /** MIME type */
  mimeType: string;
  /** Whether this is an image that should be included in prompt context */
  isImage: boolean;
}

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
  /** Optional: additional context to pass to the agent prompt */
  context?: Record<string, string>;
  /** Optional: file attachments, already downloaded to the workspace */
  attachments?: Attachment[];
}

export interface InboundMessageResult {
  rawText?: string;
  conversationId: string;
  agentId: string;
  profile?: string;
}

/**
 * Process an inbound message from any channel.
 *
 * 1. Lookup or create conversation by external ID
 * 2. Classify new conversations to route to the right agent/profile
 * 3. Launch agent with conversation history as context (fresh session each time)
 * 4. Persist messages
 * 5. Reply via the provided replyFn
 */
export async function handleInboundMessage(
  params: InboundMessageParams
): Promise<InboundMessageResult> {
  const { text, externalId, traceName, traceMetadata, replyFn, context, attachments } = params;

  const traceId = createTraceId();
  await createTrace(traceId, traceName, traceMetadata);

  try {
    let conversation = await getConversationByExternalId(externalId);
    let profile: string | undefined;

    if (conversation) {
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

      console.log(`[Messaging] Routed to ${classification.label}`);
    }

    // Build prompt with conversation history for continuity.
    // Each run is a fresh session — no --resume — so we prepend prior
    // messages so the agent has context from previous exchanges.
    const fullPrompt = buildPromptWithHistory(conversation.messages, text, attachments);

    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: conversation.agent_id,
      profile,
      prompt: fullPrompt,
      context: {
        currentTime: currentTimePST(),
        ...context,
      },
      additionalEnv: { NORTHSTAR_TRACE_ID: traceId },
    });

    const rawText = result.rawText;

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

    // Reply
    if (rawText) {
      const traceUrl = isTracingEnabled() ? getTraceUrl(traceId) : null;
      const traceLink = traceUrl ? `\n${traceUrl}` : "";
      await replyFn(rawText + traceLink);
    }

    await completeTrace(traceId, { agentId: conversation.agent_id, success: true });

    return {
      rawText,
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

/**
 * Build a prompt that includes conversation history for context.
 * Keeps recent messages (last N exchanges) to avoid blowing up the prompt.
 *
 * Attachments are filtered to only include files referenced in the
 * conversation window (via [attachment:<fileName>] markers in message content).
 * - Images: referenced by path so the agent can read them (Claude Code is multimodal)
 * - Non-images: referenced by path so the agent knows where the file is
 */
function buildPromptWithHistory(
  messages: Message[],
  currentText: string,
  attachments?: Attachment[],
): string {
  const parts: string[] = [];

  // Conversation history — last 20 messages
  const recent = messages.length > 0 ? messages.slice(-20) : [];
  if (recent.length > 0) {
    const historyLines = recent.map((m) => {
      const role = m.role === "user" ? "User" : "Assistant";
      const content = m.content.length > 1000
        ? m.content.substring(0, 1000) + "..."
        : m.content;
      return `[${role}]: ${content}`;
    });

    parts.push(
      "Conversation history (for context — this is a continuing conversation):\n" +
      historyLines.join("\n\n")
    );
  }

  // Current message
  parts.push("New message:\n" + currentText);

  // Filter attachments to only those referenced in the conversation window
  // or the current message. Messages store [attachment:<fileName>] markers.
  if (attachments && attachments.length > 0) {
    const windowText = recent.map((m) => m.content).join("\n") + "\n" + currentText;
    const referencedAttachments = attachments.filter((a) =>
      windowText.includes(`[attachment:${a.fileName}]`)
    );

    if (referencedAttachments.length > 0) {
      const attachmentLines = referencedAttachments.map((a) => {
        if (a.isImage) {
          return `Attached image: ${a.fileName} — saved to ${a.filePath} (read this file to view the image)`;
        }
        return `Attached file: ${a.fileName} (${a.mimeType}) — saved to ${a.filePath}`;
      });
      parts.push("Attachments:\n" + attachmentLines.join("\n"));
    }
  }

  return parts.join("\n\n---\n\n");
}
