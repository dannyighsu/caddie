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
import {
  createConversation,
  getConversationByExternalId,
  appendMessages,
  addSeenChannelIds,
  type Message,
} from "./db";
import type { ThreadContext } from "./thread-context";
import { parseMessageRefs, normalizeMessageId } from "./email-threading";

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

/** The agent that owns outbound-initiated email threads. */
const OUTBOUND_AGENT_ID = "buri";

/**
 * Send an ad-hoc outbound email and return AgentMail's thread/message ids.
 *
 * The resulting thread is recorded locally (keyed by `email:<threadId>`) so
 * that when the recipient replies — the reply carries the same AgentMail
 * thread id — the shared messaging handler finds the conversation and can
 * supply prior context. Without this, agent-initiated threads (scheduled
 * reminders, control-API notifications) have no local record, so replies land as
 * brand-new conversations with no history.
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  opts?: { threadContext?: ThreadContext },
): Promise<{ messageId: string; threadId: string }> {
  const client = getClient();
  const res = await client.inboxes.messages.send(getInboxId(), {
    to,
    subject,
    text,
  });

  const result = { messageId: res.messageId, threadId: res.threadId };

  // Best-effort: a failed record must not fail the send itself.
  try {
    await recordOutboundThread(
      result.threadId,
      subject,
      text,
      opts?.threadContext,
      result.messageId,
    );
  } catch (err) {
    console.error(
      `[Email] Sent to ${to} (thread ${result.threadId}) but failed to record local conversation:`,
      err,
    );
  }

  return result;
}

/**
 * Create-or-append the local conversation for an outbound-initiated thread,
 * storing the sent message as an assistant turn so it shows up as history when
 * the recipient replies. Idempotent per thread: subsequent sends on the same
 * thread append rather than duplicate the conversation.
 */
async function recordOutboundThread(
  threadId: string,
  subject: string,
  body: string,
  threadContext?: ThreadContext,
  sentMessageId?: string,
): Promise<void> {
  const externalId = `email:${threadId}`;
  const existing = await getConversationByExternalId(externalId);
  const conversationId = existing
    ? existing.id
    : (
        await createConversation(
          OUTBOUND_AGENT_ID,
          // "Notification" is the generic default subject; prefer a body snippet.
          subject && subject !== "Notification" ? subject : body.slice(0, 80),
          externalId,
          undefined,
          threadContext,
        )
      ).id;

  const message: Message = {
    role: "assistant",
    content: body,
    timestamp: new Date().toISOString(),
  };
  await appendMessages(conversationId, [message]);

  // Record our own outbound RFC Message-ID as "seen" so a reply to this message
  // is recognized as a direct continuation, not a side-conversation gap.
  if (sentMessageId) {
    const rfcId = await fetchRfcMessageId(sentMessageId);
    if (rfcId) await addSeenChannelIds(conversationId, [rfcId]);
  }
}

/**
 * Reply to an inbound message and return AgentMail's id for the sent reply. The
 * caller records that id (via its RFC `Message-ID`) as "seen" so a later reply
 * to it is recognized as a direct continuation rather than a side-conversation
 * gap. See {@link fetchRfcMessageId}.
 */
export async function replyToEmail(
  messageId: string,
  text: string,
): Promise<{ messageId: string }> {
  if (!messageId) throw new Error("replyToEmail: messageId is empty");
  const client = getClient();
  const res = await client.inboxes.messages.reply(getInboxId(), messageId, { text });
  return { messageId: res.messageId };
}

/**
 * Best-effort lookup of an outbound message's RFC 5322 `Message-ID` from its
 * AgentMail message id. The send/reply responses expose only AgentMail's own
 * ids, but threading (`In-Reply-To`) is done in RFC `Message-ID` space, so we
 * fetch the message to read its header. Returns undefined on any failure — a
 * missing id only costs a one-time, safe over-inclusion of quoted history.
 */
export async function fetchRfcMessageId(
  agentMailMessageId: string,
): Promise<string | undefined> {
  if (!agentMailMessageId) return undefined;
  const full = await fetchMessage(agentMailMessageId);
  return full?.rfcMessageId;
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
  /**
   * Full body *including* quoted/forwarded history. Preferred over
   * `extractedText` when a message loops the agent into context it hasn't seen
   * (a forward or a reply from an off-inbox side conversation).
   */
  fullText: string;
  messageId: string;
  threadId: string;
  /**
   * Normalized RFC 5322 `Message-ID` of this message (bracket-stripped), from
   * the `Message-ID` header. Distinct from AgentMail's `messageId`. Undefined if
   * the header is absent.
   */
  rfcMessageId?: string;
  /** Normalized RFC `Message-ID` this message replies to (`In-Reply-To`). */
  inReplyTo?: string;
  /** Normalized RFC `Message-ID` ancestry chain (`References`), oldest→newest. */
  references: string[];
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

  const text = pick<string>("text") ?? "";
  const html = pick<string>("html") ?? "";

  // Body resolution. `extracted_text` is the *new* content with quoted/forwarded
  // history stripped — but forwards often leave it empty (the whole body reads as
  // quoted), so fall through to the full text, then to stripped HTML. Use a
  // non-empty check rather than `??` because empty strings are present-but-blank
  // and must NOT short-circuit the chain.
  const extractedText = firstNonEmpty(
    pick<string>("extracted_text", "extractedText"),
    text,
    stripHtml(pick<string>("extracted_html", "extractedHtml")),
    stripHtml(html),
  );

  // Full body *with* quoted history — the opposite preference from
  // `extractedText`: keep the whole thread when it's the payload (forwards,
  // loop-ins), falling back to the stripped variants only if nothing else.
  const fullText = firstNonEmpty(text, stripHtml(html), extractedText);

  const { inReplyTo, references } = parseMessageRefs(headers);
  const rawMessageIdHeader = getHeader(headers, "Message-ID");
  const rfcMessageId = rawMessageIdHeader
    ? normalizeMessageId(rawMessageIdHeader)
    : undefined;

  return {
    from,
    to,
    subject: pick<string>("subject") ?? "(no subject)",
    text,
    html,
    extractedText,
    fullText,
    messageId: pick<string>("message_id", "messageId") ?? "",
    threadId: pick<string>("thread_id", "threadId") ?? "",
    rfcMessageId,
    inReplyTo,
    references,
    headers,
  };
}

/** Return the first argument that has non-whitespace content, else "". */
function firstNonEmpty(...vals: (string | undefined)[]): string {
  for (const v of vals) {
    if (v && v.trim()) return v;
  }
  return "";
}

/**
 * Fetch the full message by id via the API.
 *
 * The inbound webhook offloads the body: for anything but the smallest
 * messages it omits `text`/`html`/`extracted_text` and sends only `preview`
 * plus a short-lived `body_url`. The documented way to get the complete body
 * is the Get Message endpoint, so when the webhook body is empty we retrieve
 * the message by id and re-normalize the (now inlined) result.
 *
 * Returns null if the fetch fails so callers can fall back gracefully.
 */
export async function fetchMessage(messageId: string): Promise<ReceivedEmail | null> {
  if (!messageId) return null;
  try {
    const client = getClient();
    const full = await client.inboxes.messages.get(getInboxId(), messageId);
    return normalizeMessage(full);
  } catch (err) {
    console.error(`[Email] Failed to fetch full message ${messageId}:`, err);
    return null;
  }
}

/** Minimal HTML→text fallback for messages that arrive HTML-only. */
function stripHtml(html: string | undefined): string {
  if (!html) return "";
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
