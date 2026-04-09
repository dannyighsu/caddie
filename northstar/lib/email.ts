/**
 * Email Channel — Resend (send + receive)
 *
 * Outbound: sends via Resend API.
 * Inbound: Resend receives emails and POSTs webhook events to /api/email/webhook.
 *          The webhook contains metadata only — we call the Resend API to fetch
 *          the full email body, then strip quoted reply text.
 *
 * Env vars:
 *   RESEND_API_KEY          — Resend API key
 *   RESEND_WEBHOOK_SECRET   — webhook signing secret (from Resend dashboard)
 *   EMAIL_FROM              — sender address (must be on a verified Resend domain)
 */

import { Resend } from "resend";
import EmailReplyParser from "email-reply-parser";

// --- Config ---

export function isEmailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

function getResend(): Resend {
  return new Resend(process.env.RESEND_API_KEY!);
}

function getFromAddress(): string {
  return process.env.EMAIL_FROM!;
}

export function getFromRawAddress(): string {
  // Extract bare email from "Name <email>" format
  const from = getFromAddress();
  const match = from.match(/<(.+)>/);
  return match ? match[1] : from;
}

// --- Send ---

export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  inReplyTo?: string,
): Promise<void> {
  const resend = getResend();

  await resend.emails.send({
    from: getFromAddress(),
    to,
    subject,
    text,
    ...(inReplyTo
      ? { headers: { "In-Reply-To": inReplyTo, References: inReplyTo } }
      : {}),
  });
}

// --- Receive (fetch full email from Resend API) ---

export interface ReceivedEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string;
  messageId: string;
  createdAt: string;
}

export async function fetchReceivedEmail(
  emailId: string,
): Promise<ReceivedEmail | null> {
  const resend = getResend();

  const { data, error } = await resend.emails.receiving.get(emailId);

  if (error || !data) {
    console.error("[Email] Failed to fetch received email:", error);
    return null;
  }

  return {
    from: data.from,
    to: data.to,
    subject: data.subject ?? "(no subject)",
    text: data.text ?? "",
    html: data.html ?? "",
    messageId: data.message_id ?? emailId,
    createdAt: data.created_at,
  };
}

// --- Webhook verification ---

export function verifyWebhook(
  payload: string,
  requestHeaders: globalThis.Headers,
): unknown | null {
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // No secret configured — skip verification (dev mode)
    return JSON.parse(payload);
  }

  const resend = getResend();

  try {
    return resend.webhooks.verify({
      payload,
      headers: {
        id: requestHeaders.get("svix-id") ?? "",
        timestamp: requestHeaders.get("svix-timestamp") ?? "",
        signature: requestHeaders.get("svix-signature") ?? "",
      },
      webhookSecret,
    });
  } catch (err) {
    console.error("[Email] Webhook verification failed:", err);
    return null;
  }
}

// --- Reply parsing ---

export function extractLatestReply(text: string): string {
  const parser = new EmailReplyParser();
  const parsed = parser.read(text);
  const visible = parsed.getVisibleText().trim();
  return visible || text.trim();
}
