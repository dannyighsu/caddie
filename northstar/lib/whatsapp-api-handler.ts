/**
 * WhatsApp Cloud API Message Handler
 *
 * Processes inbound WhatsApp messages received via the Meta Cloud API webhook.
 * Mirrors the Baileys handler pattern — delegates to the shared messaging handler
 * for classification, agent execution, and conversation persistence.
 *
 * Cloud API only receives DMs (business accounts don't participate in groups
 * the same way), so every message triggers the agent.
 */

import {
  getConversationByExternalId,
  storeWhatsAppMessage,
  getRecentWhatsAppMessages,
} from "./db";
import { handleInboundMessage } from "./messaging";
import { sendCloudAPIMessage } from "./whatsapp-api";

const MESSAGE_LOOKBACK = 20;

interface CloudAPIMessageEvent {
  text: string;
  from: string;
  senderName: string;
  messageId: string;
  timestamp: Date;
}

/**
 * Handle a single inbound message from the Cloud API webhook.
 */
export async function handleCloudAPIMessage(
  msg: CloudAPIMessageEvent,
): Promise<void> {
  const { text, from, senderName, messageId, timestamp } = msg;
  const chatId = from; // Phone number is the chat ID for DMs
  const externalId = `whatsapp:${chatId}`;

  // Store the message for context
  await storeWhatsAppMessage(
    chatId,
    from,
    senderName,
    messageId,
    text,
    timestamp,
  );

  // Fetch recent messages for context
  const recentMessages = await getRecentWhatsAppMessages(chatId, MESSAGE_LOOKBACK);

  let conversationContext = "";
  if (recentMessages.length > 1) {
    const contextLines = recentMessages
      .filter((m) => m.wa_message_id !== messageId)
      .map((m) => `[${m.sender_name ?? m.sender_id}]: ${m.content}`);

    if (contextLines.length > 0) {
      conversationContext =
        "Recent conversation history (for context):\n" +
        contextLines.join("\n") +
        "\n\n---\n\n";
    }
  }

  const fullPrompt = conversationContext + text;

  try {
    await handleInboundMessage({
      text: fullPrompt,
      externalId,
      traceName: "whatsapp-message",
      traceMetadata: { chatId, from, senderName, via: "cloud-api" },
      replyFn: async (replyText) => {
        const cleaned = replyText.replace(/\nhttps?:\/\/[^\s]+$/, "").trim();
        await sendCloudAPIMessage(from, cleaned);
      },
      routingConfirmFn: async (label) => {
        await sendCloudAPIMessage(from, `Routed to ${label}`);
      },
    });
  } catch (err) {
    console.error("[WhatsApp API Handler] Error:", err);
  }
}
