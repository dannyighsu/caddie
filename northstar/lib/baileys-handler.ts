/**
 * Baileys WhatsApp Message Handler
 *
 * Processes inbound WhatsApp messages received via Baileys (WhatsApp Web protocol).
 * Delegates to the shared messaging handler for classification,
 * agent execution, and conversation persistence.
 *
 * Chat activation model (same as the Cloud API handler):
 *   - DMs: all messages trigger the agent
 *   - Groups: only @mentions of the bot trigger the agent;
 *     other messages are stored for context
 */

import {
  getConversationByExternalId,
  storeWhatsAppMessage,
  getRecentWhatsAppMessages,
} from "./db";
import { handleInboundMessage } from "./messaging";
import {
  isBotMentioned,
  stripBotMention,
  getBotName,
  getBotJid,
  type BaileysMessageHandler,
} from "./baileys";

const MESSAGE_LOOKBACK = 20;

/**
 * Handle a single incoming Baileys WhatsApp message.
 * Wired into startBaileys() as the message callback.
 */
export const handleBaileysMessage: BaileysMessageHandler = async ({
  text,
  chatId,
  senderId,
  senderName,
  messageId,
  isGroup,
  timestamp,
  reply,
}) => {
  const externalId = `whatsapp:${chatId}`;

  // In groups, check for @mention; in DMs, always respond
  const mentioned = isGroup ? isBotMentionedBaileys(text) : true;

  // Check if this chat is active (has a conversation record)
  const conversation = await getConversationByExternalId(externalId);
  const isActiveChat = !!conversation;

  if (!isActiveChat && !mentioned) {
    // Inactive group chat, no mention → discard
    return;
  }

  // Store the message for context (reuses existing WhatsApp message table)
  await storeWhatsAppMessage(
    chatId,
    senderId,
    senderName,
    messageId,
    text,
    timestamp,
  );

  if (!mentioned) {
    // Active chat but no mention → just store for context, don't trigger agent
    return;
  }

  // Clean up the mention from the text
  const cleanedText = isGroup ? stripBotMention(text) : text;
  if (!cleanedText) return;

  // Fetch recent messages for context
  const recentMessages = await getRecentWhatsAppMessages(chatId, MESSAGE_LOOKBACK);

  // Build conversation context string
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

  const fullPrompt = conversationContext + cleanedText;

  try {
    await handleInboundMessage({
      text: fullPrompt,
      externalId,
      traceName: "whatsapp-message",
      traceMetadata: { chatId, from: senderId, senderName, via: "baileys" },
      replyFn: async (replyText) => {
        // Strip trace URL for WhatsApp (not useful in chat)
        const cleaned = replyText.replace(/\nhttps?:\/\/[^\s]+$/, "").trim();
        await reply(cleaned);
      },
      routingConfirmFn: async (label) => {
        await reply(`Routed to ${label}`);
      },
    });
  } catch (err) {
    console.error("[Baileys Handler] Error:", err);
  }
};

/**
 * Check if the bot is mentioned in a message.
 * Supports both @BotName mentions and @phone-number mentions
 * (Baileys uses the bot's JID for @mentions in groups).
 */
function isBotMentionedBaileys(text: string): boolean {
  // Check the configured bot name (reuses existing helper)
  if (isBotMentioned(text)) return true;

  // Also check if the bot's JID/phone is mentioned
  const botJid = getBotJid();
  if (botJid) {
    // JID format: 1234567890@s.whatsapp.net — extract phone number
    const phone = botJid.split("@")[0].split(":")[0];
    if (text.includes(`@${phone}`)) return true;
  }

  // Check for bot name without @ prefix (some clients don't add @)
  const botName = getBotName();
  if (botName && new RegExp(`\\b${escapeRegex(botName)}\\b`, "i").test(text)) {
    return true;
  }

  return false;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
