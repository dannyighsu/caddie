/**
 * Baileys WhatsApp Client
 *
 * Connects to WhatsApp via the Baileys library (WhatsApp Web multi-device protocol).
 * Works like Slack Socket Mode — outbound connection, no public URL or
 * Meta Business account required. Just scan the QR code with your phone.
 *
 * Env vars:
 *   WHATSAPP_BAILEYS           — set to "true" to enable Baileys mode
 *   WHATSAPP_BAILEYS_AUTH_DIR  — path to persist auth state (default: .baileys-auth)
 *   WHATSAPP_BOT_NAME          — display name for @mention detection (optional)
 */

import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  DisconnectReason,
  type WASocket,
  type BaileysEventMap,
} from "@whiskeysockets/baileys";
import { join } from "path";

let sock: WASocket | null = null;
let started = false;

export type BaileysMessageHandler = (event: {
  text: string;
  chatId: string;
  senderId: string;
  senderName: string;
  messageId: string;
  isGroup: boolean;
  timestamp: Date;
  /** Send a reply to this specific message */
  reply: (text: string) => Promise<void>;
}) => Promise<void>;

/**
 * Check if Baileys mode is enabled via env vars.
 */
export function isBaileysEnabled(): boolean {
  return process.env.WHATSAPP_BAILEYS === "true";
}

/**
 * Start the Baileys WhatsApp connection.
 * Safe to call multiple times — only starts once.
 *
 * On first run, a QR code is printed to the terminal. Scan it with
 * WhatsApp > Settings > Linked Devices > Link a Device.
 */
export async function startBaileys(onMessage: BaileysMessageHandler): Promise<void> {
  if (started) return;
  if (!isBaileysEnabled()) {
    console.warn("[Baileys] WHATSAPP_BAILEYS is not set to 'true', skipping");
    return;
  }

  started = true;

  const authDir = process.env.WHATSAPP_BAILEYS_AUTH_DIR || join(process.cwd(), ".baileys-auth");
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const connect = async () => {
    sock = makeWASocket({
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, undefined as never),
      },
      printQRInTerminal: true,
    });

    // Persist auth credentials whenever they change
    sock.ev.on("creds.update", saveCreds);

    // Connection lifecycle
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        console.log("[Baileys] QR code printed above — scan with WhatsApp to link this device");
      }

      if (connection === "close") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          console.error("[Baileys] Logged out — delete auth folder and restart to re-link");
          started = false;
        } else {
          console.warn(`[Baileys] Disconnected (status ${statusCode}), reconnecting...`);
          // Reconnect after a short delay
          setTimeout(() => connect(), 3000);
        }
      } else if (connection === "open") {
        console.log("[Baileys] Connected to WhatsApp");
      }
    });

    // Incoming messages
    sock.ev.on("messages.upsert", async ({ messages, type }: BaileysEventMap["messages.upsert"]) => {
      if (type !== "notify") return;

      for (const msg of messages) {
        // Skip messages sent by us
        if (msg.key.fromMe) continue;

        // Extract text content
        const text =
          msg.message?.conversation ||
          msg.message?.extendedTextMessage?.text;
        if (!text) continue;

        const chatId = msg.key.remoteJid;
        if (!chatId) continue;

        const isGroup = chatId.endsWith("@g.us");
        const senderId = isGroup
          ? (msg.key.participant || chatId)
          : chatId;
        const senderName = msg.pushName || senderId;
        const messageId = msg.key.id || "";
        const timestamp = msg.messageTimestamp
          ? new Date(Number(msg.messageTimestamp) * 1000)
          : new Date();

        try {
          await onMessage({
            text,
            chatId,
            senderId,
            senderName,
            messageId,
            isGroup,
            timestamp,
            reply: async (replyText: string) => {
              await sendBaileysMessage(chatId, replyText, msg);
            },
          });
        } catch (err) {
          console.error("[Baileys] Message handler error:", err);
        }
      }
    });
  };

  await connect();
}

/**
 * Send a text message via Baileys.
 */
export async function sendBaileysMessage(
  chatId: string,
  text: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  quotedMessage?: any,
): Promise<void> {
  if (!sock) throw new Error("Baileys not connected");

  await sock.sendMessage(chatId, { text }, quotedMessage ? { quoted: quotedMessage } : undefined);
}

/**
 * Get the bot's own JID (phone number) if connected.
 */
export function getBotJid(): string | undefined {
  return sock?.user?.id;
}

/**
 * Check if Baileys is currently connected.
 */
export function isBaileysConnected(): boolean {
  return sock !== null;
}

// --- Bot mention utilities ---

export function getBotName(): string {
  return process.env.WHATSAPP_BOT_NAME ?? "";
}

/**
 * Check if a message text contains an @mention of our bot.
 */
export function isBotMentioned(text: string): boolean {
  const botName = getBotName();
  if (!botName) return false;
  const pattern = new RegExp(`@${escapeRegex(botName)}\\b`, "i");
  return pattern.test(text);
}

/**
 * Strip the @BotName mention from the message text.
 */
export function stripBotMention(text: string): string {
  const botName = getBotName();
  if (!botName) return text;
  const pattern = new RegExp(`@${escapeRegex(botName)}\\b\\s*`, "gi");
  return text.replace(pattern, "").trim();
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
