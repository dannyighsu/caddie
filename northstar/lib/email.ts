/**
 * Email Channel — AgentMail (send + receive)
 *
 * Outbound: sends via AgentMail API.
 * Inbound: AgentMail receives emails and POSTs webhook events to /api/email/webhook.
 *          The webhook payload already includes the full message (with `extractedText`
 *          stripped of quoted history), so no follow-up fetch is needed.
 *
 * Env vars:
 *   AGENTMAIL_API_KEY        — AgentMail API key
 *   AGENTMAIL_INBOX_ID       — the inbox to send/receive on (e.g. "agent@agentmail.to")
 *   AGENTMAIL_WEBHOOK_SECRET — Svix-format signing secret ("whsec_...")
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
  return process.env.AGENTMAIL_INBOX_ID!;
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

export async function fetchReceivedEmail(
  messageId: string,
): Promise<ReceivedEmail | null> {
  const client = getClient();
  try {
    const msg = await client.inboxes.messages.get(getInboxId(), messageId);
    return normalizeMessage(msg);
  } catch (err) {
    console.error("[Email] Failed to fetch message:", err);
    return null;
  }
}

// Accepts either the AgentMail webhook payload's `message` object or a
// `messages.get` response — fields are identically shaped between the two.
export function normalizeMessage(input: unknown): ReceivedEmail {
  const msg = input as Record<string, unknown>;
  const fromField = msg.from;
  const from =
    typeof fromField === "string"
      ? fromField
      : ((fromField as { address?: string } | undefined)?.address ?? "");
  const toField = Array.isArray(msg.to) ? msg.to : [];
  const to = toField.map((t) =>
    typeof t === "string" ? t : ((t as { address?: string })?.address ?? ""),
  );
  return {
    from,
    to,
    subject: (msg.subject as string | undefined) ?? "(no subject)",
    text: (msg.text as string | undefined) ?? "",
    html: (msg.html as string | undefined) ?? "",
    extractedText:
      (msg.extractedText as string | undefined) ??
      (msg.text as string | undefined) ??
      "",
    messageId: msg.messageId as string,
    threadId: msg.threadId as string,
  };
}

// --- Webhook verification ---

export interface InboundWebhookEvent {
  event: string;
  message: unknown;
}

export function verifyWebhook(
  payload: string,
  requestHeaders: globalThis.Headers,
): InboundWebhookEvent | null {
  const secret = process.env.AGENTMAIL_WEBHOOK_SECRET;
  if (!secret) {
    // No secret configured — skip verification (dev mode)
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
