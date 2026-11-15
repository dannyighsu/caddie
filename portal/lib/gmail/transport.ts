/**
 * Gmail transport — low-level send/receive against the Gmail API.
 *
 * Adapted from mcinteerj/openclaw-gmail (MIT): reply-recipient + threading-header
 * reconstruction (resolveReplyContext), MIME send, and payload parsing. Inbound
 * uses the plugin's proven "UNREAD label as the queue" pattern instead of the
 * historyId/Pub-Sub machinery — the mailbox's own UNREAD state is the cursor.
 */

import { type gmail_v1 } from "googleapis";
import { getGmailClient } from "./client";
import { buildMimeMessage } from "./mime";
import { extractParts, type GmailPart } from "./parts";
import {
  buildReplyContext,
  getHeaderCI,
  parseEmailAddresses,
  selectReplyAnchor,
  type ReplyContext,
} from "./reply-address";

// ── Address + header helpers ──────────────────────────────────────────

// Addressing rules live in ./reply-address (pure, unit-tested); re-exported
// here so the transport stays the single import surface for Gmail plumbing.
export { parseEmailAddresses, selectReplyAnchor, buildReplyContext };
export type { ParsedAddress } from "./reply-address";

function headerMap(payload: gmail_v1.Schema$MessagePart | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of payload?.headers ?? []) {
    if (h.name && h.value != null && out[h.name] === undefined) out[h.name] = h.value;
  }
  return out;
}

// ── Body extraction (prefer text/plain and text/html) ─────────────────

function decode(data: string | null | undefined): string {
  return data ? Buffer.from(data, "base64url").toString("utf-8") : "";
}

/** Recursively pull the best text/plain and text/html bodies from a payload. */
export function extractBodies(part: gmail_v1.Schema$MessagePart | undefined): {
  html: string;
  plain: string;
} {
  let html = "";
  let plain = "";
  if (!part) return { html, plain };

  const walk = (p: gmail_v1.Schema$MessagePart) => {
    if (p.mimeType === "text/plain" && p.body?.data) {
      if (!plain) plain = decode(p.body.data);
    } else if (p.mimeType === "text/html" && p.body?.data) {
      if (!html) html = decode(p.body.data);
    }
    for (const sub of p.parts ?? []) walk(sub);
  };
  walk(part);
  return { html, plain };
}

// ── Attachment bytes ──────────────────────────────────────────────────

/**
 * Fetch one attachment's bytes. Returns null when Gmail no longer has the part
 * (404) — a message deleted mid-poll shouldn't fail the whole dispatch.
 */
export async function getAttachmentBytes(
  messageId: string,
  attachmentId: string,
): Promise<Buffer | null> {
  const gmail = await getGmailClient();
  try {
    const res = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: attachmentId,
    });
    return res.data.data ? Buffer.from(res.data.data, "base64url") : null;
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 404) return null;
    throw err;
  }
}

// ── Parsed inbound message ────────────────────────────────────────────

export interface GmailInbound {
  id: string;
  threadId: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  html: string;
  plain: string;
  /** Attached and inline files (metadata only — see {@link extractParts}). */
  parts: GmailPart[];
  headers: Record<string, string>;
  labelIds: string[];
  internalDate?: string;
}

function parseMessage(msg: gmail_v1.Schema$Message): GmailInbound {
  const headers = headerMap(msg.payload);
  const { html, plain } = extractBodies(msg.payload);
  const parts = extractParts(msg.payload);
  return {
    id: msg.id!,
    threadId: msg.threadId!,
    from: getHeaderCI(headers, "From") ?? "",
    to: parseEmailAddresses(getHeaderCI(headers, "To")).map((a) => a.email),
    cc: parseEmailAddresses(getHeaderCI(headers, "Cc")).map((a) => a.email),
    subject: getHeaderCI(headers, "Subject") ?? "(no subject)",
    html,
    plain,
    parts,
    headers,
    labelIds: msg.labelIds ?? [],
    internalDate: msg.internalDate ?? undefined,
  };
}

// ── Inbound: list / get / mark-read ───────────────────────────────────

/** Message ids currently in INBOX and UNREAD — the poll queue. */
export async function listUnreadInboxIds(max = 25): Promise<string[]> {
  const gmail = await getGmailClient();
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "label:INBOX label:UNREAD",
    maxResults: max,
  });
  return (res.data.messages ?? []).map((m) => m.id!).filter(Boolean);
}

export async function getInboundMessage(id: string): Promise<GmailInbound | null> {
  const gmail = await getGmailClient();
  try {
    const res = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    return parseMessage(res.data);
  } catch (err: unknown) {
    if ((err as { code?: number })?.code === 404) return null;
    throw err;
  }
}

/**
 * Mark a single message read (drops UNREAD from that message only).
 *
 * UNREAD is the poll queue, so what gets cleared has to match exactly what was
 * handled. Clearing at thread level instead — which this used to do, for more
 * reliable label propagation — silently ate any sibling message that arrived in
 * the same thread while the handled one was still being dispatched: it was
 * de-queued without ever having been read, and no later poll would see it
 * again — no run, no error, and no signal anywhere. Keep this message-level.
 */
export async function markMessageRead(messageId: string): Promise<void> {
  const gmail = await getGmailClient();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: { removeLabelIds: ["UNREAD"] },
  });
}

/** Read a message's RFC 5322 Message-ID header (for seen-id / threading bookkeeping). */
export async function getRfcMessageId(id: string): Promise<string | undefined> {
  const gmail = await getGmailClient();
  try {
    const res = await gmail.users.messages.get({
      userId: "me",
      id,
      format: "metadata",
      metadataHeaders: ["Message-ID"],
    });
    const headers = headerMap(res.data.payload);
    return getHeaderCI(headers, "Message-ID");
  } catch {
    return undefined;
  }
}

// ── Outbound: reply-context reconstruction + send ─────────────────────

/**
 * Resolve reply recipients + threading headers from a thread message.
 * Reply-all rebuilds To+Cc (minus self) exactly like a mail client; a plain
 * reply targets just the other party. Adapted from openclaw-gmail api-client.ts.
 *
 * `anchorMessageId` is the message being replied to; see
 * {@link selectReplyAnchor}.
 */
async function resolveReplyContext(
  threadId: string,
  selfEmail: string,
  replyAll: boolean,
  anchorMessageId?: string,
): Promise<ReplyContext | null> {
  const gmail = await getGmailClient();
  const res = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
  const messages = res.data.messages ?? [];
  if (messages.length === 0) return null;

  const anchor = selectReplyAnchor(messages, anchorMessageId);
  if (!anchor) return null;

  return buildReplyContext({
    anchorHeaders: headerMap(anchor.payload),
    threadSubject: getHeaderCI(headerMap(messages[0].payload), "Subject"),
    selfEmail,
    replyAll,
  });
}

async function rawSend(opts: {
  from: string;
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string;
  threadId?: string;
}): Promise<{ messageId: string; threadId: string }> {
  const gmail = await getGmailClient();
  const mime = await buildMimeMessage(opts);
  const res = await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: mime.toString("base64url"), threadId: opts.threadId },
  });
  return { messageId: res.data.id!, threadId: res.data.threadId! };
}

/** Extra recipients for an outbound send, already rendered as header strings. */
export interface Recipients {
  /** Comma-separated Cc list. */
  cc?: string;
  /** Comma-separated Bcc list. */
  bcc?: string;
}

/**
 * Send a brand-new email (new thread). `to` may be a comma-separated list, and
 * `opts.cc`/`opts.bcc` add the other header fields. Supplying `html` produces a
 * `multipart/alternative` with `text` as the plain-text alternative.
 */
export async function sendNewEmail(
  self: string,
  to: string,
  subject: string,
  text: string,
  html?: string,
  opts?: Recipients,
): Promise<{ messageId: string; threadId: string }> {
  return rawSend({ from: self, to, subject, text, html, cc: opts?.cc, bcc: opts?.bcc });
}

/**
 * Send into an existing thread — including one *we* started.
 *
 * {@link sendReply} covers answering an inbound message: it is keyed on that
 * message's id and rebuilds the recipient set from the thread. This covers the
 * other direction, a deliberate follow-up on a thread the agent is running, so
 * `to`/`cc` are the caller's to choose. Threading headers (`In-Reply-To`,
 * `References`) and the `Re:` subject still come from the thread's last message,
 * which is what makes the follow-up land in the same conversation in the
 * recipient's mail client rather than opening a second one.
 *
 * Falls back to the thread's own recipients and subject when the caller gives
 * none. Returns null when the thread has no messages (nothing to thread onto) —
 * the caller decides whether to send it as a new thread instead.
 */
export async function sendThreadedEmail(
  self: string,
  threadId: string,
  text: string,
  opts?: Recipients & { to?: string; subject?: string; html?: string },
): Promise<{ messageId: string; threadId: string } | null> {
  const ctx = await resolveReplyContext(threadId, self, /* replyAll */ false);
  if (!ctx) return null;

  const to = opts?.to ?? ctx.to;
  if (!to) return null;

  return rawSend({
    from: self,
    to,
    cc: opts?.cc,
    bcc: opts?.bcc,
    subject: opts?.subject ?? ctx.subject ?? "(no subject)",
    text,
    html: opts?.html,
    inReplyTo: ctx.inReplyTo,
    references: ctx.references,
    threadId,
  });
}

/**
 * Reply to `sourceMessageId`. Resolves its thread, reconstructs recipients +
 * threading headers **from that message** (not from the thread's latest one —
 * see {@link selectReplyAnchor}), and sends as part of the thread.
 *
 * Returns the resolved recipients alongside the ids so the caller can surface
 * who the reply actually went to.
 */
export async function sendReply(
  self: string,
  sourceMessageId: string,
  text: string,
  replyAll: boolean,
): Promise<{ messageId: string; threadId: string; to: string; cc?: string }> {
  const gmail = await getGmailClient();
  // Find the thread this message belongs to.
  const src = await gmail.users.messages.get({
    userId: "me",
    id: sourceMessageId,
    format: "metadata",
    metadataHeaders: ["Subject"],
  });
  const threadId = src.data.threadId;
  if (!threadId) throw new Error(`sendReply: no threadId for message ${sourceMessageId}`);

  const ctx = await resolveReplyContext(threadId, self, replyAll, sourceMessageId);
  if (!ctx || !ctx.to) throw new Error(`sendReply: could not resolve recipients for thread ${threadId}`);

  const sent = await rawSend({
    from: self,
    to: ctx.to,
    cc: ctx.cc,
    subject: ctx.subject ?? "(no subject)",
    text,
    inReplyTo: ctx.inReplyTo,
    references: ctx.references,
    threadId,
  });
  return { ...sent, to: ctx.to, cc: ctx.cc };
}
