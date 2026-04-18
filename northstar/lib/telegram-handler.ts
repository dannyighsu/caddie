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
 *
 * Attachments: photos, documents, audio, voice, and video are downloaded
 * to the workspace artifacts directory and passed as channel-agnostic
 * Attachment objects to the shared messaging handler. Attachments are
 * downloaded eagerly in active conversations (even without @mention)
 * so they're available when the bot is next triggered.
 */

import { resolve } from "path";
import { mkdir, writeFile, readdir } from "fs/promises";
import {
  getConversationByExternalId,
  storeTelegramMessage,
} from "./db";
import { handleInboundMessage, type Attachment } from "./messaging";
import { workspaceRoot } from "./harness";
import {
  sendTelegramMessage,
  isBotMentioned,
  stripBotMention,
  formatSenderName,
  extractAttachment,
  downloadTelegramFile,
  type TelegramMessage,
} from "./telegram";

const IMAGE_MIME_PREFIXES = ["image/"];

function isImageMime(mimeType: string): boolean {
  return IMAGE_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
}

/**
 * Get the artifacts directory for today's runs.
 * Creates the directory if it doesn't exist.
 */
async function getArtifactsDir(agentId: string): Promise<string> {
  const now = new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const year = pst.getFullYear();
  const month = String(pst.getMonth() + 1).padStart(2, "0");
  const day = String(pst.getDate());
  const dayName = pst.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

  const dir = resolve(workspaceRoot, agentId, "runs", `${year}-${month}`, `${day}_${dayName}`, "artifacts");
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Download a Telegram attachment and save it to the workspace artifacts directory.
 * Returns a channel-agnostic Attachment or null on failure.
 */
async function downloadAndSaveAttachment(
  msg: TelegramMessage,
  agentId: string,
): Promise<Attachment | null> {
  const info = extractAttachment(msg);
  if (!info) return null;

  try {
    const { buffer } = await downloadTelegramFile(info.fileId);
    const artifactsDir = await getArtifactsDir(agentId);
    const savedPath = resolve(artifactsDir, info.fileName);
    await writeFile(savedPath, buffer);

    console.log(`[Telegram] Saved attachment: ${info.fileName} (${info.mimeType}) → ${savedPath}`);

    return {
      filePath: savedPath,
      fileName: info.fileName,
      mimeType: info.mimeType,
      isImage: isImageMime(info.mimeType),
    };
  } catch (err) {
    console.error(`[Telegram] Failed to download attachment:`, err);
    return null;
  }
}

/**
 * Scan the artifacts directory for recently saved files.
 * Returns Attachment objects for all files found, so the agent can
 * reference attachments that were saved before it was @mentioned.
 */
async function collectRecentAttachments(agentId: string): Promise<Attachment[]> {
  try {
    const artifactsDir = await getArtifactsDir(agentId);
    const files = await readdir(artifactsDir);
    return files.map((fileName) => {
      const filePath = resolve(artifactsDir, fileName);
      const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
      const mimeType = extToMime(ext);
      return { filePath, fileName, mimeType, isImage: isImageMime(mimeType) };
    });
  } catch {
    return [];
  }
}

function extToMime(ext: string): string {
  const map: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
    gif: "image/gif", webp: "image/webp", bmp: "image/bmp",
    mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo",
    mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav",
    pdf: "application/pdf", doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    txt: "text/plain", csv: "text/csv", json: "application/json",
  };
  return map[ext] ?? "application/octet-stream";
}

/**
 * Handle a single inbound Telegram message.
 */
export async function handleTelegramMessage(msg: TelegramMessage): Promise<void> {
  // Messages can have text, attachments (with optional caption), or both
  const textContent = msg.text ?? msg.caption ?? "";
  const hasAttachment = !!(msg.photo || msg.document || msg.audio || msg.voice || msg.video);

  if (!textContent && !hasAttachment) return;

  const chatId = String(msg.chat.id);
  const senderId = msg.from ? String(msg.from.id) : chatId;
  const senderName = formatSenderName(msg.from);
  const messageId = String(msg.message_id);
  const timestamp = new Date(msg.date * 1000);
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const externalId = `telegram:${chatId}`;

  // For @mention detection, check both text and caption entities
  const mentioned = isGroup ? isBotMentioned(msg) : true;

  // Check if this chat is active (has a conversation record)
  const conversation = await getConversationByExternalId(externalId);
  const isActiveChat = !!conversation;

  if (!isActiveChat && !mentioned) {
    return;
  }

  const agentId = conversation?.agent_id ?? "buri";

  // Download attachments eagerly in active conversations — even without
  // @mention — so they're available when the bot is next triggered.
  if (hasAttachment) {
    await downloadAndSaveAttachment(msg, agentId);
  }

  // Store the message text for context
  const storedContent = hasAttachment && !textContent
    ? "[attachment]"
    : textContent;
  await storeTelegramMessage(
    chatId, senderId, senderName, messageId, storedContent, timestamp,
  );

  if (!mentioned) {
    return;
  }

  // Clean up the mention from the text
  const cleanedText = isGroup ? stripBotMention(textContent) : textContent;

  // Collect ALL recent attachments from the artifacts directory — this
  // includes files saved from earlier messages that weren't @mentions.
  const attachments = await collectRecentAttachments(agentId);

  // Determine prompt text
  let promptText = cleanedText;
  if (!promptText && attachments.length > 0) {
    promptText = "[User sent an attachment]";
  } else if (!promptText) {
    promptText = `${senderName} mentioned you`;
  }

  // Pass only the cleaned user message — conversation history is handled
  // by messaging.ts via the DB conversation record. Do NOT prepend
  // Telegram chat history here; that causes nested duplication.
  try {
    await handleInboundMessage({
      text: promptText,
      externalId,
      traceName: "telegram-message",
      traceMetadata: { chatId, senderId, senderName, chatType: msg.chat.type },
      context: { originChannel: "telegram" },
      attachments: attachments.length > 0 ? attachments : undefined,
      replyFn: async (replyText) => {
        await sendTelegramMessage(chatId, replyText, {
          replyToMessageId: msg.message_id,
        });
      },
    });
  } catch (err) {
    console.error("[Telegram Handler] Error:", err);
  }
}
