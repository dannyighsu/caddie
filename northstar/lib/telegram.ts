/**
 * Telegram Bot API Client
 *
 * Sends and receives messages via the official Telegram Bot API.
 * Inbound messages arrive via webhook; outbound via simple HTTPS POST.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN       — bot token from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET  — optional secret token for webhook verification
 *   TELEGRAM_BOT_USERNAME    — bot's @username (without @), for @mention detection in groups
 */

const API_BASE = "https://api.telegram.org";

// --- Types for webhook payloads ---

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramMessageEntity {
  type: string;
  offset: number;
  length: number;
  user?: TelegramUser;
}

// --- Config ---

export function isTelegramConfigured(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN;
}

function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  return token;
}

export function getBotUsername(): string {
  return process.env.TELEGRAM_BOT_USERNAME ?? "";
}

export function getWebhookSecret(): string {
  return process.env.TELEGRAM_WEBHOOK_SECRET ?? "";
}

// --- Webhook signature verification ---

/**
 * Telegram sends a secret token in the X-Telegram-Bot-Api-Secret-Token header
 * if one was configured when the webhook was registered. We verify it matches.
 * If no secret is configured, verification is skipped (dev mode).
 */
export function verifyWebhookSecret(headerValue: string | null): boolean {
  const expected = getWebhookSecret();
  if (!expected) return true;
  return headerValue === expected;
}

// --- Send messages ---

export async function sendTelegramMessage(
  chatId: string | number,
  text: string,
  options?: {
    parseMode?: "Markdown" | "MarkdownV2" | "HTML";
    replyToMessageId?: number;
  },
): Promise<void> {
  const url = `${API_BASE}/bot${getBotToken()}/sendMessage`;

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text,
  };
  if (options?.parseMode) body.parse_mode = options.parseMode;
  if (options?.replyToMessageId) body.reply_to_message_id = options.replyToMessageId;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Telegram API error (${res.status}): ${detail}`);
  }
}

// --- Bot mention utilities ---

/**
 * Check if the bot is mentioned in a message (via @username in text entities).
 * In groups, only mentions trigger the agent; DMs always trigger.
 */
export function isBotMentioned(msg: TelegramMessage): boolean {
  const botUsername = getBotUsername();
  if (!botUsername || !msg.text || !msg.entities) return false;

  for (const entity of msg.entities) {
    if (entity.type !== "mention") continue;
    const mentionText = msg.text.slice(entity.offset, entity.offset + entity.length);
    if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
      return true;
    }
  }
  return false;
}

/**
 * Strip the @BotUsername mention from the message text.
 */
export function stripBotMention(text: string): string {
  const botUsername = getBotUsername();
  if (!botUsername) return text;
  const pattern = new RegExp(`@${escapeRegex(botUsername)}\\b\\s*`, "gi");
  return text.replace(pattern, "").trim();
}

/**
 * Returns a human-readable sender name from a Telegram user.
 */
export function formatSenderName(user: TelegramUser | undefined): string {
  if (!user) return "unknown";
  if (user.username) return `@${user.username}`;
  const parts = [user.first_name, user.last_name].filter(Boolean);
  return parts.join(" ") || String(user.id);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
