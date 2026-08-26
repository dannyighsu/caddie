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
import { workspaceRoot, defaultAgentId } from "./harness";
import {
  sendTelegramMessage,
  isBotMentioned,
  stripBotMention,
  formatSenderName,
  extractAttachment,
  downloadTelegramFile,
  resolveTelegramIdentity,
  type TelegramMessage,
} from "./telegram";

const IMAGE_MIME_PREFIXES = ["image/"];

function isImageMime(mimeType: string): boolean {
  return IMAGE_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
}

/**
 * Get the artifacts directory for Telegram attachments, scoped to a specific chat.
 * Keeps Telegram files separate from other agent artifacts (feed-scan snapshots, etc.).
 */
async function getTelegramAttachmentsDir(agentId: string, chatId: string): Promise<string> {
  const now = new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const year = pst.getFullYear();
  const month = String(pst.getMonth() + 1).padStart(2, "0");
  const day = String(pst.getDate());
  const dayName = pst.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

  const dir = resolve(workspaceRoot, agentId, "runs", `${year}-${month}`, `${day}_${dayName}`, "artifacts", `telegram-${chatId}`);
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
  chatId: string,
): Promise<Attachment | null> {
  const info = extractAttachment(msg);
  if (!info) return null;

  try {
    const { buffer } = await downloadTelegramFile(info.fileId);
    const attachDir = await getTelegramAttachmentsDir(agentId, chatId);
    const savedPath = resolve(attachDir, info.fileName);
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
 * Scan the chat-scoped attachments directory for saved files.
 * Returns Attachment objects for all files from this chat, so the agent
 * can reference attachments that were saved before it was @mentioned.
 */
async function collectChatAttachments(agentId: string, chatId: string): Promise<Attachment[]> {
  try {
    const attachDir = await getTelegramAttachmentsDir(agentId, chatId);
    const files = await readdir(attachDir);
    return files.map((fileName) => {
      const filePath = resolve(attachDir, fileName);
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

  if (!textContent && !hasAttachment) {
    console.log(
      `[Telegram Handler] Skipping message: no text or attachment chat=${msg.chat.id} messageId=${msg.message_id}`,
    );
    return;
  }

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
    console.log(
      `[Telegram Handler] Skipping message: inactive chat and bot not mentioned chat=${chatId} sender=${senderName}`,
    );
    return;
  }

  const agentId = conversation?.agent_id ?? (await defaultAgentId());

  // Download attachments eagerly in active conversations — even without
  // @mention — so they're available when the bot is next triggered.
  let savedAttachment: Attachment | null = null;
  if (hasAttachment) {
    savedAttachment = await downloadAndSaveAttachment(msg, agentId, chatId);
  }

  // Store the message text for context. Include the filename in the marker
  // so we can match attachments to messages when building the prompt.
  let storedContent = textContent;
  if (savedAttachment) {
    const marker = `[attachment:${savedAttachment.fileName}]`;
    storedContent = storedContent ? `${storedContent}\n${marker}` : marker;
  } else if (hasAttachment && !textContent) {
    storedContent = "[attachment]";
  }
  await storeTelegramMessage(
    chatId, senderId, senderName, messageId, storedContent, timestamp,
  );

  if (!mentioned) {
    console.log(
      `[Telegram Handler] Skipping trigger: bot not mentioned (message stored for context) chat=${chatId} sender=${senderName}`,
    );
    return;
  }

  // Clean up the mention from the text
  const cleanedText = isGroup ? stripBotMention(textContent) : textContent;

  // Collect all downloaded attachments for this chat. The messaging layer
  // will filter to only those referenced in the conversation window.
  const allChatAttachments = await collectChatAttachments(agentId, chatId);

  // Determine prompt text
  let promptText = cleanedText;
  if (!promptText && allChatAttachments.length > 0) {
    promptText = "[User sent an attachment]";
  } else if (!promptText) {
    promptText = `${senderName} mentioned you`;
  }

  // Pass only the cleaned user message — conversation history is handled
  // by messaging.ts via the DB conversation record. Do NOT prepend
  // Telegram chat history here; that causes nested duplication.
  const identity = resolveTelegramIdentity(msg.from);
  console.log(
    `[Telegram Handler] Identity: kind=${identity.kind}` +
      (identity.kind === "authenticated" ? ` userId=${identity.userId}` : "") +
      ` rawSender=${identity.rawSender}`,
  );

  try {
    await handleInboundMessage({
      text: promptText,
      externalId,
      traceName: "telegram-message",
      identity,
      traceMetadata: { chatId, senderId, senderName, chatType: msg.chat.type },
      context: { originChannel: "telegram" },
      attachments: allChatAttachments.length > 0 ? allChatAttachments : undefined,
      // Inbound conversations respond via the `reply` tool (with the escape
      // hatch); only direct portal runs auto-deliver final text.
      deliveryMode: "tool",
      replyTarget: {
        channel: "telegram",
        externalId,
        telegram: { chatId, replyToMessageId: msg.message_id },
      },
      // Used only for the error-notice path in tool mode.
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
