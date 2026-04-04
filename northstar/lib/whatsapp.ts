/**
 * WhatsApp Cloud API Client
 *
 * Sending messages via the Meta Graph API + webhook signature verification.
 *
 * Env vars:
 *   WHATSAPP_ACCESS_TOKEN    — Meta access token (System User or long-lived)
 *   WHATSAPP_PHONE_NUMBER_ID — Your business phone number ID (from Meta dashboard)
 *   WHATSAPP_VERIFY_TOKEN    — Token for webhook verification handshake
 *   WHATSAPP_BOT_NAME        — Display name to detect @mentions (e.g. "Buri")
 *   WHATSAPP_APP_SECRET      — App secret for webhook signature verification
 */

import { createHmac } from "crypto";

const GRAPH_API_VERSION = "v21.0";

function getAccessToken(): string {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN environment variable is not set");
  return token;
}

function getPhoneNumberId(): string {
  const id = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!id) throw new Error("WHATSAPP_PHONE_NUMBER_ID environment variable is not set");
  return id;
}

// --- Sending ---

export async function sendWhatsAppMessage(
  to: string,
  text: string,
  replyToMessageId?: string
): Promise<string | undefined> {
  const phoneNumberId = getPhoneNumberId();
  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`;

  const body: Record<string, unknown> = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: text },
  };

  if (replyToMessageId) {
    body.context = { message_id: replyToMessageId };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getAccessToken()}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error(`[WhatsApp] Send failed (${res.status}):`, errorBody);
    throw new Error(`WhatsApp send failed: ${res.status}`);
  }

  const data = await res.json();
  return data.messages?.[0]?.id as string | undefined;
}

// --- Configuration checks ---

export function isWhatsAppConfigured(): boolean {
  return !!(
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}

export function getVerifyToken(): string {
  return process.env.WHATSAPP_VERIFY_TOKEN ?? "";
}

export function getBotName(): string {
  return process.env.WHATSAPP_BOT_NAME ?? "";
}

// --- Mention detection ---

/**
 * Check if a message text contains an @mention of our bot.
 * WhatsApp doesn't parse mentions in the API — we match on the bot's display name.
 */
export function isBotMentioned(text: string): boolean {
  const botName = getBotName();
  if (!botName) return false;

  // Match @BotName or just the bot name preceded by @ anywhere in text (case-insensitive)
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

// --- Webhook signature verification ---

/**
 * Verify the X-Hub-Signature-256 header from Meta's webhook payload.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string
): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    console.warn("[WhatsApp] WHATSAPP_APP_SECRET not set, skipping signature verification");
    return true;
  }

  const expectedSignature =
    "sha256=" +
    createHmac("sha256", appSecret)
      .update(rawBody)
      .digest("hex");

  return expectedSignature === signature;
}

// --- Webhook payload types ---

export interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: WhatsAppWebhookValue;
      field: string;
    }>;
  }>;
}

export interface WhatsAppWebhookValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: Array<{
    profile: { name: string };
    wa_id: string;
  }>;
  messages?: Array<WhatsAppIncomingMessage>;
  statuses?: Array<{
    id: string;
    status: string;
    timestamp: string;
    recipient_id: string;
  }>;
}

export interface WhatsAppIncomingMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
  context?: {
    message_id: string;
    from: string;
  };
  /** Present for group messages (if supported by the account) */
  group_id?: string;
}

/**
 * Extract messages from a webhook payload.
 */
export function extractMessages(
  payload: WhatsAppWebhookPayload
): Array<{
  message: WhatsAppIncomingMessage;
  senderName: string;
  phoneNumberId: string;
}> {
  const results: Array<{
    message: WhatsAppIncomingMessage;
    senderName: string;
    phoneNumberId: string;
  }> = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages") continue;
      const value = change.value;
      if (!value.messages) continue;

      const contactMap = new Map<string, string>();
      for (const contact of value.contacts ?? []) {
        contactMap.set(contact.wa_id, contact.profile.name);
      }

      for (const message of value.messages) {
        results.push({
          message,
          senderName: contactMap.get(message.from) ?? message.from,
          phoneNumberId: value.metadata.phone_number_id,
        });
      }
    }
  }

  return results;
}
