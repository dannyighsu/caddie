/**
 * Email Channel — AgentMail (send + receive)
 *
 * Outbound: sends via AgentMail API.
 * Inbound: AgentMail receives emails and POSTs webhook events to /api/email/webhook.
 *          The webhook payload already includes the full message (with `extracted_text`
 *          stripped of quoted history), so no follow-up fetch is needed.
 *
 * Env vars:
 *   AGENTMAIL_API_KEY        — AgentMail API key
 *   AGENTMAIL_INBOX_ID       — the inbox to send/receive on (e.g. "agent@agentmail.to")
 *   AGENTMAIL_SIGNING_SECRET — Svix-format signing secret ("whsec_...")
 */

import { AgentMailClient } from "agentmail";
import { Webhook } from "svix";

// --- Config ---

export function isEmailConfigured(): boolean {
  return !!(process.env.AGENTMAIL_API_KEY && process.env.AGENTMAIL_INBOX_ID);
}

function getClient(): AgentMailClient {
  return new AgentMailClient({ apiKey: process.env.AGENTMAIL_API_KEY! });
}

function getInboxId(): string {
  const id = process.env.AGENTMAIL_INBOX_ID;
  if (!id) throw new Error("AGENTMAIL_INBOX_ID is not set");
  return id;
}

export function getFromRawAddress(): string {
  return getInboxId();
}

// --- Send ---

export async function sendEmail(
  to: string,
  subject: string,
  text: string,
): Promise<void> {
  const client = getClient();
  await client.inboxes.messages.send(getInboxId(), {
    to,
    subject,
    text,
  });
}

export async function replyToEmail(
  messageId: string,
  text: string,
): Promise<void> {
  if (!messageId) throw new Error("replyToEmail: messageId is empty");
  const client = getClient();
  await client.inboxes.messages.reply(getInboxId(), messageId, { text });
}

// --- Receive ---

export interface ReceivedEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  /** Body with quoted reply history stripped (preferred for agent context). */
  extractedText: string;
  messageId: string;
  threadId: string;
}

// AgentMail webhook JSON is snake_case on the wire. The SDK's typed responses
// are camelCase. Read both so this works for either source.
export function normalizeMessage(input: unknown): ReceivedEmail {
  const msg = input as Record<string, unknown>;
  const pick = <T = string>(...keys: string[]): T | undefined => {
    for (const k of keys) {
      const v = msg[k];
      if (v !== undefined && v !== null) return v as T;
    }
    return undefined;
  };

  const fromField = pick<unknown>("from");
  const from =
    typeof fromField === "string"
      ? fromField
      : ((fromField as { address?: string } | undefined)?.address ?? "");
  const toField = pick<unknown[]>("to") ?? [];
  const to = (Array.isArray(toField) ? toField : []).map((t) =>
    typeof t === "string" ? t : ((t as { address?: string })?.address ?? ""),
  );

  return {
    from,
    to,
    subject: pick<string>("subject") ?? "(no subject)",
    text: pick<string>("text") ?? "",
    html: pick<string>("html") ?? "",
    extractedText:
      pick<string>("extracted_text", "extractedText") ??
      pick<string>("text") ??
      "",
    messageId: pick<string>("message_id", "messageId") ?? "",
    threadId: pick<string>("thread_id", "threadId") ?? "",
  };
}

// --- Webhook verification ---

// The AgentMail webhook envelope. Field names are snake_case on the wire.
export interface InboundWebhookEvent {
  type: string;
  event_type: string;
  event_id?: string;
  message: unknown;
  thread?: unknown;
}

export function verifyWebhook(
  payload: string,
  requestHeaders: globalThis.Headers,
): InboundWebhookEvent | null {
  const secret = process.env.AGENTMAIL_SIGNING_SECRET;
  if (!secret) {
    // No secret configured — skip verification (dev mode).
    console.warn("[Email] AGENTMAIL_SIGNING_SECRET not set — accepting unverified webhook");
    return JSON.parse(payload) as InboundWebhookEvent;
  }

  const wh = new Webhook(secret);
  try {
    return wh.verify(payload, {
      "svix-id": requestHeaders.get("svix-id") ?? "",
      "svix-timestamp": requestHeaders.get("svix-timestamp") ?? "",
      "svix-signature": requestHeaders.get("svix-signature") ?? "",
    }) as InboundWebhookEvent;
  } catch (err) {
    console.error("[Email] Webhook verification failed:", err);
    return null;
  }
}
