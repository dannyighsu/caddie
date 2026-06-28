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
import type { ResolvedIdentity, UserId } from "./identity";

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
  /** Raw RFC 5322 headers from the inbound message (header name → value). */
  headers: Record<string, string>;
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

  const rawHeaders = pick<unknown>("headers");
  const headers: Record<string, string> = {};
  if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
    for (const [k, v] of Object.entries(rawHeaders as Record<string, unknown>)) {
      if (typeof v === "string") headers[k] = v;
    }
  }

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
    headers,
  };
}

// --- Identity resolution ---

function bareAddress(field: string): string {
  const match = field.match(/<([^>]+)>/);
  return (match ? match[1] : field).trim().toLowerCase();
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target && v) return v;
  }
  return undefined;
}

interface AuthResults {
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

// RFC 7601: `method=result` pairs separated by `;`, prefixed by the
// authserv-id. First occurrence of each method wins — that's the trusted
// ADMD's stamp; downstream re-stamps from forwarders are advisory.
function parseAuthenticationResults(value: string): AuthResults {
  const results: AuthResults = {};
  for (const part of value.split(";")) {
    const match = part.trim().match(/^(spf|dkim|dmarc)\s*=\s*([a-z]+)/i);
    if (!match) continue;
    const method = match[1].toLowerCase() as keyof AuthResults;
    if (!results[method]) results[method] = match[2].toLowerCase();
  }
  return results;
}

function householdEmailMap(): Map<string, UserId> {
  const map = new Map<string, UserId>();
  const add = (envValue: string | undefined, userId: UserId) => {
    if (!envValue) return;
    for (const addr of envValue.split(",")) {
      const cleaned = addr.trim().toLowerCase();
      if (cleaned) map.set(cleaned, userId);
    }
  };
  add(process.env.DANNY_EMAIL, "danny");
  add(process.env.BETTY_EMAIL, "betty");
  return map;
}

/**
 * Resolve an inbound email to a household identity or fall back to guest.
 *
 * Requires both:
 *   1. `From` address matches DANNY_EMAIL or BETTY_EMAIL (case-insensitive).
 *   2. An Authentication-Results header with spf=pass, dkim=pass, dmarc=pass.
 *
 * Any failure downgrades to guest — we'd rather lose authenticated access
 * than grant it on a spoofed `From`. AgentMail does not surface
 * SPF/DKIM/DMARC as first-class webhook fields, so this is the only
 * spoofing defense available at the message boundary.
 */
export function resolveEmailIdentity(email: ReceivedEmail): ResolvedIdentity {
  const sender = bareAddress(email.from);
  const userId = householdEmailMap().get(sender);

  if (!userId) {
    return { kind: "guest", channel: "email", rawSender: sender };
  }

  const authResults = getHeader(email.headers, "Authentication-Results");
  if (!authResults) {
    console.warn(
      `[Email Identity] Allowlisted sender ${sender} missing Authentication-Results — downgrading to guest`,
    );
    return { kind: "guest", channel: "email", rawSender: sender };
  }

  const parsed = parseAuthenticationResults(authResults);
  if (parsed.spf !== "pass" || parsed.dkim !== "pass" || parsed.dmarc !== "pass") {
    console.warn(
      `[Email Identity] Allowlisted sender ${sender} did not pass all auth checks (spf=${parsed.spf} dkim=${parsed.dkim} dmarc=${parsed.dmarc}) — downgrading to guest`,
    );
    return { kind: "guest", channel: "email", rawSender: sender };
  }

  return { kind: "authenticated", userId, channel: "email", rawSender: sender };
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
