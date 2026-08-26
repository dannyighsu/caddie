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

import type { ResolvedIdentity, UserId } from "./identity";
import { teamLookup } from "@agints/harness";

const API_BASE = "https://api.telegram.org";

// --- Types for webhook payloads ---

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
}

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  file_unique_id: string;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVoice {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramVideo {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  entities?: TelegramMessageEntity[];
  caption_entities?: TelegramMessageEntity[];
  reply_to_message?: TelegramMessage;
  photo?: TelegramPhotoSize[];
  document?: TelegramDocument;
  audio?: TelegramAudio;
  voice?: TelegramVoice;
  video?: TelegramVideo;
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

/**
 * Check if a chat ID is on the allowlist.
 * If TELEGRAM_ALLOWED_CHATS is not set, all chats are allowed (open mode).
 * The allowlist is a comma-separated list of chat IDs (can be negative for groups).
 */
export function isChatAllowed(chatId: number): boolean {
  const allowlist = process.env.TELEGRAM_ALLOWED_CHATS;
  if (!allowlist) return true;
  const allowed = allowlist.split(",").map((id) => id.trim());
  return allowed.includes(String(chatId));
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

// --- File downloads ---

interface TelegramFileInfo {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/**
 * Download a file from Telegram by file_id.
 * Returns the file contents as a Buffer and the original filename/extension.
 */
export async function downloadTelegramFile(
  fileId: string,
): Promise<{ buffer: Buffer; filePath: string }> {
  const token = getBotToken();

  // Step 1: get file path
  const infoRes = await fetch(`${API_BASE}/bot${token}/getFile?file_id=${fileId}`);
  if (!infoRes.ok) {
    const detail = await infoRes.text();
    throw new Error(`Telegram getFile error (${infoRes.status}): ${detail}`);
  }
  const info = (await infoRes.json()) as { ok: boolean; result: TelegramFileInfo };
  if (!info.ok || !info.result.file_path) {
    throw new Error("Telegram getFile returned no file_path");
  }

  // Step 2: download
  const downloadUrl = `${API_BASE}/file/bot${token}/${info.result.file_path}`;
  const fileRes = await fetch(downloadUrl);
  if (!fileRes.ok) {
    throw new Error(`Telegram file download error (${fileRes.status})`);
  }

  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, filePath: info.result.file_path };
}

/**
 * Extract attachment info from a Telegram message.
 * Returns null if the message has no attachments.
 */
export function extractAttachment(msg: TelegramMessage): {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize?: number;
} | null {
  // Photos: array of sizes, pick the largest
  if (msg.photo && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    return {
      fileId: largest.file_id,
      fileName: `photo_${largest.file_unique_id}.jpg`,
      mimeType: "image/jpeg",
      fileSize: largest.file_size,
    };
  }

  if (msg.document) {
    return {
      fileId: msg.document.file_id,
      fileName: msg.document.file_name ?? `document_${msg.document.file_unique_id}`,
      mimeType: msg.document.mime_type ?? "application/octet-stream",
      fileSize: msg.document.file_size,
    };
  }

  if (msg.audio) {
    return {
      fileId: msg.audio.file_id,
      fileName: msg.audio.file_name ?? `audio_${msg.audio.file_unique_id}`,
      mimeType: msg.audio.mime_type ?? "audio/mpeg",
      fileSize: msg.audio.file_size,
    };
  }

  if (msg.voice) {
    return {
      fileId: msg.voice.file_id,
      fileName: `voice_${msg.voice.file_unique_id}.ogg`,
      mimeType: msg.voice.mime_type ?? "audio/ogg",
      fileSize: msg.voice.file_size,
    };
  }

  if (msg.video) {
    return {
      fileId: msg.video.file_id,
      fileName: msg.video.file_name ?? `video_${msg.video.file_unique_id}.mp4`,
      mimeType: msg.video.mime_type ?? "video/mp4",
      fileSize: msg.video.file_size,
    };
  }

  return null;
}

// --- Bot mention utilities ---

/**
 * Check if the bot is mentioned in a message (via @username in text or caption entities).
 * In groups, only mentions trigger the agent; DMs always trigger.
 */
export function isBotMentioned(msg: TelegramMessage): boolean {
  const botUsername = getBotUsername();
  if (!botUsername) return false;

  // Check both text entities and caption entities (for messages with attachments)
  const checks: { text?: string; entities?: TelegramMessageEntity[] }[] = [
    { text: msg.text, entities: msg.entities },
    { text: msg.caption, entities: msg.caption_entities },
  ];

  for (const { text, entities } of checks) {
    if (!text || !entities) continue;
    for (const entity of entities) {
      if (entity.type !== "mention") continue;
      const mentionText = text.slice(entity.offset, entity.offset + entity.length);
      if (mentionText.toLowerCase() === `@${botUsername.toLowerCase()}`) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Strip the @BotUsername mention from text (works on both text and captions).
 */
export function stripBotMention(text: string): string {
  const botUsername = getBotUsername();
  if (!botUsername || !text) return text ?? "";
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

// --- Identity resolution ---

/** Telegram user id -> team member id, from the roster. */
function teamTelegramMap(): Map<string, UserId> {
  return teamLookup("telegramId");
}

/**
 * Resolve a Telegram message's sender against the team roster.
 * The webhook secret is verified upstream in the route handler, so the
 * `from.id` here is treated as a verified Telegram user ID.
 */
export function resolveTelegramIdentity(
  from: TelegramUser | undefined,
): ResolvedIdentity {
  if (!from) {
    return { kind: "guest", channel: "telegram", rawSender: "unknown" };
  }
  const rawSender = String(from.id);
  const userId = teamTelegramMap().get(String(rawSender).toLowerCase());
  if (userId) {
    return { kind: "authenticated", userId, channel: "telegram", rawSender };
  }
  return { kind: "guest", channel: "telegram", rawSender };
}
