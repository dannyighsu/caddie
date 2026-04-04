/**
 * WhatsApp Message Handler
 *
 * Processes inbound WhatsApp messages received via webhook.
 *
 * Chat activation model:
 *   - A chat becomes "active" when the bot is first @mentioned in it.
 *   - Active chats are identified by having a conversation record with
 *     external_id = "whatsapp:{chatId}".
 *   - All messages in active chats are stored for context (rolling log).
 *   - Messages in inactive chats are discarded.
 *
 * When the bot is @mentioned:
 *   1. Store the incoming message
 *   2. Fetch the last 20 messages from the chat as context
 *   3. Build a prompt with that context + the current message
 *   4. Delegate to the shared messaging handler
 *   5. Reply via WhatsApp API
 */

import {
  getConversationByExternalId,
  storeWhatsAppMessage,
  getRecentWhatsAppMessages,
} from "./db";
import {
  isBotMentioned,
  stripBotMention,
  sendWhatsAppMessage,
  type WhatsAppIncomingMessage,
} from "./whatsapp";
import { handleInboundMessage } from "./messaging";

const MESSAGE_LOOKBACK = 20;

/**
 * Handle a single incoming WhatsApp message.
 */
export async function handleWhatsAppMessage(
  message: WhatsAppIncomingMessage,
  senderName: string,
): Promise<void> {
  // Only handle text messages
  if (message.type !== "text" || !message.text?.body) return;

  const text = message.text.body;
  const chatId = message.group_id ?? message.from;
  const externalId = `whatsapp:${chatId}`;
  const mentioned = isBotMentioned(text);

  // Check if this chat is active (has a conversation record)
  const conversation = await getConversationByExternalId(externalId);
  const isActiveChat = !!conversation;

  if (!isActiveChat && !mentioned) {
    // Inactive chat, no mention → discard
    return;
  }

  // Store the message (active chat or first mention)
  const timestamp = new Date(parseInt(message.timestamp) * 1000);
  await storeWhatsAppMessage(
    chatId,
    message.from,
    senderName,
    message.id,
    text,
    timestamp,
  );

  if (!mentioned) {
    // Active chat but no mention → just store for context, don't trigger agent
    return;
  }

  // Bot was mentioned — build context and trigger agent
  const cleanedText = stripBotMention(text);
  if (!cleanedText) return;

  // Fetch recent messages for context
  const recentMessages = await getRecentWhatsAppMessages(chatId, MESSAGE_LOOKBACK);

  // Build conversation context string
  let conversationContext = "";
  if (recentMessages.length > 1) {
    const contextLines = recentMessages
      // Exclude the current message (it's the prompt)
      .filter((m) => m.wa_message_id !== message.id)
      .map((m) => `[${m.sender_name ?? m.sender_id}]: ${m.content}`);

    if (contextLines.length > 0) {
      conversationContext =
        "Recent conversation history (for context):\n" +
        contextLines.join("\n") +
        "\n\n---\n\n";
    }
  }

  const fullPrompt = conversationContext + cleanedText;

  try {
    await handleInboundMessage({
      text: fullPrompt,
      externalId,
      traceName: "whatsapp-message",
      traceMetadata: { chatId, from: message.from, senderName },
      replyFn: async (replyText) => {
        // Strip trace URL for WhatsApp (not useful in chat)
        const cleaned = replyText.replace(/\nhttps?:\/\/[^\s]+$/, "").trim();
        await sendWhatsAppMessage(message.from, cleaned, message.id);
      },
      routingConfirmFn: async (label) => {
        await sendWhatsAppMessage(
          message.from,
          `Routed to ${label}`,
          message.id,
        );
      },
    });
  } catch (err) {
    console.error("[WhatsApp] Handler error:", err);
  }
}
