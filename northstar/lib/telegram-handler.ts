/**
 * Telegram Message Handler
 *
 * Processes inbound Telegram messages received via the Bot API webhook.
 * Delegates to the shared messaging handler for classification,
 * agent execution, and conversation persistence.
 *
 * Chat activation model:
 *   - DMs (private chats): every message triggers the agent
 *   - Groups/supergroups: only @mentions of the bot trigger the agent;
 *     other messages are stored for context
 */

import {
  getConversationByExternalId,
  storeTelegramMessage,
  getRecentTelegramMessages,
} from "./db";
import { handleInboundMessage } from "./messaging";
import {
  sendTelegramMessage,
  isBotMentioned,
  stripBotMention,
  formatSenderName,
  type TelegramMessage,
} from "./telegram";

const MESSAGE_LOOKBACK = 20;

/**
 * Handle a single inbound Telegram message.
 */
export async function handleTelegramMessage(msg: TelegramMessage): Promise<void> {
  if (!msg.text) return;

  const chatId = String(msg.chat.id);
  const senderId = msg.from ? String(msg.from.id) : chatId;
  const senderName = formatSenderName(msg.from);
  const messageId = String(msg.message_id);
  const timestamp = new Date(msg.date * 1000);
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const externalId = `telegram:${chatId}`;

  // In groups, check for @mention; in DMs, always respond
  const mentioned = isGroup ? isBotMentioned(msg) : true;

  // Check if this chat is active (has a conversation record)
  const conversation = await getConversationByExternalId(externalId);
  const isActiveChat = !!conversation;

  if (!isActiveChat && !mentioned) {
    // Inactive group chat, no mention → discard
    return;
  }

  // Store the message for context
  await storeTelegramMessage(
    chatId,
    senderId,
    senderName,
    messageId,
    msg.text,
    timestamp,
  );

  if (!mentioned) {
    // Active chat but no mention → just store for context, don't trigger agent
    return;
  }

  // Clean up the mention from the text
  const cleanedText = isGroup ? stripBotMention(msg.text) : msg.text;
  if (!cleanedText) return;

  // Fetch recent messages for context
  const recentMessages = await getRecentTelegramMessages(chatId, MESSAGE_LOOKBACK);

  let conversationContext = "";
  if (recentMessages.length > 1) {
    const contextLines = recentMessages
      .filter((m) => m.tg_message_id !== messageId)
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
      traceName: "telegram-message",
      traceMetadata: { chatId, senderId, senderName, chatType: msg.chat.type },
      context: { originChannel: "telegram" },
      replyFn: async (replyText) => {
        // Strip trace URL for Telegram (trace link is still in the reply but kept as plain URL)
        await sendTelegramMessage(chatId, replyText, {
          replyToMessageId: msg.message_id,
        });
      },
      routingConfirmFn: async (label) => {
        await sendTelegramMessage(chatId, `Routed to ${label}`);
      },
    });
  } catch (err) {
    console.error("[Telegram Handler] Error:", err);
  }
}
