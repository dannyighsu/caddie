/**
 * WhatsApp Cloud API Client
 *
 * Sends and receives messages via the Meta WhatsApp Business API.
 * Requires a Meta Business account and a dedicated phone number.
 *
 * Env vars:
 *   WHATSAPP_ACCESS_TOKEN      — permanent or long-lived access token
 *   WHATSAPP_PHONE_NUMBER_ID   — the phone number ID from Meta dashboard
 *   WHATSAPP_APP_SECRET        — app secret for webhook signature verification
 *   WHATSAPP_VERIFY_TOKEN      — arbitrary string you set during webhook setup
 */

const API_VERSION = "v22.0";

// --- Types for webhook payloads ---

export interface WebhookPayload {
  object: string;
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  id: string;
  changes: WebhookChange[];
}

export interface WebhookChange {
  value: {
    messaging_product: string;
    metadata: {
      display_phone_number: string;
      phone_number_id: string;
    };
    contacts?: { profile: { name: string }; wa_id: string }[];
    messages?: WebhookMessage[];
    statuses?: unknown[];
  };
  field: string;
}

export interface WebhookMessage {
  from: string;
  id: string;
  timestamp: string;
  type: string;
  text?: { body: string };
}

// --- Config ---

export function isCloudAPIConfigured(): boolean {
  return !!(
    process.env.WHATSAPP_ACCESS_TOKEN &&
    process.env.WHATSAPP_PHONE_NUMBER_ID
  );
}

export function getVerifyToken(): string {
  return process.env.WHATSAPP_VERIFY_TOKEN ?? "";
}

function getBaseUrl(): string {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}`;
}

function getAccessToken(): string {
  return process.env.WHATSAPP_ACCESS_TOKEN ?? "";
}

// --- Webhook signature verification ---

export async function verifyWebhookSignature(
  rawBody: Buffer,
  signature: string | null,
): Promise<boolean> {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) {
    // If no app secret configured, skip verification (dev mode)
    return true;
  }
  if (!signature) return false;

  // Signature format: "sha256=<hex>"
  const expectedSig = signature.startsWith("sha256=")
    ? signature.slice(7)
    : signature;

  const crypto = await import("crypto");
  const hmac = crypto.createHmac("sha256", appSecret);
  hmac.update(rawBody);
  const computed = hmac.digest("hex");

  return crypto.timingSafeEqual(
    Buffer.from(computed, "hex"),
    Buffer.from(expectedSig, "hex"),
  );
}

// --- Send messages ---

export async function sendCloudAPIMessage(
  to: string,
  text: string,
): Promise<void> {
  const url = `${getBaseUrl()}/messages`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text },
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`WhatsApp Cloud API error (${res.status}): ${body}`);
  }
}

// --- Mark messages as read ---

export async function markAsRead(messageId: string): Promise<void> {
  const url = `${getBaseUrl()}/messages`;

  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getAccessToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    }),
  });
}

// --- Extract messages from webhook payload ---

export function extractMessages(
  payload: WebhookPayload,
): {
  text: string;
  from: string;
  senderName: string;
  messageId: string;
  timestamp: Date;
}[] {
  const results: {
    text: string;
    from: string;
    senderName: string;
    messageId: string;
    timestamp: Date;
  }[] = [];

  for (const entry of payload.entry) {
    for (const change of entry.changes) {
      const value = change.value;
      if (!value.messages) continue;

      const contactMap = new Map<string, string>();
      for (const c of value.contacts ?? []) {
        contactMap.set(c.wa_id, c.profile.name);
      }

      for (const msg of value.messages) {
        if (msg.type !== "text" || !msg.text?.body) continue;

        results.push({
          text: msg.text.body,
          from: msg.from,
          senderName: contactMap.get(msg.from) ?? msg.from,
          messageId: msg.id,
          timestamp: new Date(Number(msg.timestamp) * 1000),
        });
      }
    }
  }

  return results;
}
