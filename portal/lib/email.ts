/**
 * Email Channel — Gmail (send + receive)
 *
 * Outbound: sends via the Gmail API (see ./gmail/transport).
 * Inbound: the Gmail poller (./gmail/poller) lists INBOX+UNREAD each tick, builds
 *          a {@link ReceivedEmail} via {@link receivedFromGmail}, and hands it to
 *          the shared handler. Both message bodies are computed locally —
 *          `fullText` keeps quoted history; `extractedText` is the quote-stripped
 *          visible reply.
 *
 * Auth reuses the shared Google OAuth token (Calendar + Gmail) — see ./gmail/client.
 */

import type { ResolvedIdentity, UserId } from "./identity";
import {
  createConversation,
  getConversationByExternalId,
  appendMessages,
  appendAssistantReply,
  addSeenChannelIds,
  type Message,
} from "./db";
import type { ThreadContext } from "./thread-context";
import { teamLookup } from "@ignis/harness";
import { parseMessageRefs, normalizeMessageId, summarizeEnvelope } from "./email-threading";
import { isGmailConfigured, getSelfAddress } from "./gmail/client";
import {
  sendNewEmail,
  sendThreadedEmail,
  sendReply,
  getRfcMessageId,
  getInboundMessage,
  type GmailInbound,
} from "./gmail/transport";
import { selectInboundImages, selectInboundFiles, type GmailPart } from "./gmail/parts";
import { stripQuotedReply } from "./gmail/strip";
import { htmlToText } from "./gmail/html-text";

// Re-exported: callers that format outbound mail (the control API) need it, and
// the email channel is where it belongs conceptually.
export { htmlToText };

// --- Config ---

/** Configured when Gmail creds + the shared token file are present. */
export function isEmailConfigured(): boolean {
  return isGmailConfigured();
}

/** The agent's own Gmail address (the send/receive identity). */
export async function getFromRawAddress(): Promise<string> {
  return getSelfAddress();
}

// --- Send ---


/**
 * Send an ad-hoc outbound email and return AgentMail's thread/message ids.
 *
 * The resulting thread is recorded locally (keyed by `email:<threadId>`) so
 * that when the recipient replies — the reply carries the same AgentMail
 * thread id — the shared messaging handler finds the conversation and can
 * supply prior context. Without this, agent-initiated threads (scheduled
 * reminders, control-API notifications) have no local record, so replies land as
 * brand-new conversations with no history.
 *
 * Pass `opts.html` to send a formatted message: the result is a
 * `multipart/alternative` carrying both bodies, and `text` becomes the
 * plain-text alternative shown by text-only clients. Callers that have only
 * HTML should derive `text` with {@link htmlToText} rather than passing the
 * markup — `text` is also what gets stored as conversation history, which the
 * agent re-reads on the next turn.
 *
 * `to` may be a comma-separated list, and `opts.cc`/`opts.bcc` reach the other
 * header fields — so "send this and copy X" puts X on the thread rather than in
 * a separate mail. `opts.threadId` continues an existing thread instead of
 * opening a new one; see {@link sendThreadedEmail}.
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  opts?: {
    threadContext?: ThreadContext;
    html?: string;
    /** Comma-separated additional recipients. */
    cc?: string;
    bcc?: string;
    /**
     * Continue an existing Gmail thread instead of starting a new one — used
     * for a follow-up on a thread the agent itself opened. Threading headers
     * come from the thread's last message, so the follow-up lands in the same
     * conversation for the recipient. A thread that can no longer be resolved
     * (deleted, or not ours) falls back to sending as a new thread rather than
     * failing the send.
     */
    threadId?: string;
  },
): Promise<{ messageId: string; threadId: string }> {
  const self = await getSelfAddress();
  const threaded = opts?.threadId
    ? await sendThreadedEmail(self, opts.threadId, text, {
        to,
        // Blank means "reuse the thread's subject" — see sendThreadedEmail.
        subject: subject || undefined,
        html: opts.html,
        cc: opts.cc,
        bcc: opts.bcc,
      })
    : null;
  if (opts?.threadId && !threaded) {
    console.warn(
      `[Email] Thread ${opts.threadId} could not be resolved — sending as a new thread instead.`,
    );
  }
  const result =
    threaded ??
    (await sendNewEmail(self, to, subject, text, opts?.html, {
      cc: opts?.cc,
      bcc: opts?.bcc,
    }));

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
 *
 * Defaults to reply-all: AgentMail reconstructs the original recipient set
 * (To + Cc, excluding our own inbox) from the referenced message, so a group
 * thread stays a group thread. This never reaches anyone new — only people
 * already on the thread. Pass `replyAll: false` to answer just the sender
 * (e.g. a deliberately private reply); single-recipient threads are unaffected
 * either way, since reply-all degrades to a plain reply when nobody else is on.
 */
export async function replyToEmail(
  messageId: string,
  text: string,
  opts?: { replyAll?: boolean },
): Promise<{ messageId: string }> {
  if (!messageId) throw new Error("replyToEmail: messageId is empty");
  const replyAll = opts?.replyAll ?? true;
  const self = await getSelfAddress();
  const res = await sendReply(self, messageId, text, replyAll);
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
  messageId: string,
): Promise<string | undefined> {
  if (!messageId) return undefined;
  const raw = await getRfcMessageId(messageId);
  return raw ? normalizeMessageId(raw) : undefined;
}

/**
 * Record an agent reply that was just delivered into an existing thread: append
 * it as an assistant turn on the local conversation (so replayed history mirrors
 * the real, user-visible thread) and register its RFC `Message-ID` as seen (so a
 * later reply to it isn't mistaken for a side-conversation gap). Called from the
 * control `reply` action after `replyToEmail` succeeds.
 */
export async function recordEmailReply(
  externalId: string,
  sentMessageId: string,
  replyText: string,
): Promise<void> {
  const conversationId = await appendAssistantReply(externalId, replyText);
  if (!conversationId) {
    console.warn(`[Email] recordEmailReply: no conversation for ${externalId}`);
    return;
  }
  const rfcId = await fetchRfcMessageId(sentMessageId);
  if (rfcId) await addSeenChannelIds(conversationId, [rfcId]);
}

// --- Receive ---

export interface ReceivedEmail {
  from: string;
  to: string[];
  /** Cc recipients (addresses). Empty when none / not surfaced. */
  cc: string[];
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
  /** Gmail message id. */
  messageId: string;
  /** Gmail thread id (stable; used to key the local conversation). */
  threadId: string;
  /**
   * Normalized RFC 5322 `Message-ID` of this message (bracket-stripped), from
   * the `Message-ID` header. Distinct from Gmail's `messageId`. Undefined if the
   * header is absent.
   */
  rfcMessageId?: string;
  /** Normalized RFC `Message-ID` this message replies to (`In-Reply-To`). */
  inReplyTo?: string;
  /** Normalized RFC `Message-ID` ancestry chain (`References`), oldest→newest. */
  references: string[];
  /** Raw RFC 5322 headers from the inbound message (header name → value). */
  headers: Record<string, string>;
  /**
   * Images worth showing the agent, already filtered by
   * {@link selectInboundImages} but not yet downloaded — metadata only, so a
   * message that gets skipped costs no fetches. The handler downloads these.
   */
  imageParts: GmailPart[];
  /**
   * Non-image files (PDFs, documents, invites) to download — see
   * {@link selectInboundFiles}. Metadata only, like `imageParts`.
   */
  fileParts: GmailPart[];
  /**
   * Files that were attached but won't be downloaded (too large, or past the
   * per-message cap). Reported to the agent by name so an attachment is never
   * silently invisible.
   */
  unfetchedFileParts: GmailPart[];
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
    const inbound = await getInboundMessage(messageId);
    return inbound ? receivedFromGmail(inbound) : null;
  } catch (err) {
    console.error(`[Email] Failed to fetch full message ${messageId}:`, err);
    return null;
  }
}

/**
 * Build a {@link ReceivedEmail} from a parsed Gmail message. Computes both
 * bodies locally — `fullText` keeps quoted history; `extractedText` is the
 * quote-stripped visible reply — preserving the same dual-body contract that
 * AgentMail's `extracted_text` used to provide.
 */
export function receivedFromGmail(m: GmailInbound): ReceivedEmail {
  const plainOrHtml = firstNonEmpty(m.plain, htmlToText(m.html));
  const fullText = plainOrHtml;
  const extractedText = firstNonEmpty(stripQuotedReply(plainOrHtml), fullText);

  const { inReplyTo, references } = parseMessageRefs(m.headers);
  const rawMessageId = getHeader(m.headers, "Message-ID");
  const rfcMessageId = rawMessageId ? normalizeMessageId(rawMessageId) : undefined;
  const files = selectInboundFiles(m.parts);

  return {
    from: m.from,
    to: m.to,
    cc: m.cc,
    subject: m.subject,
    text: m.plain,
    html: m.html,
    extractedText,
    fullText,
    messageId: m.id,
    threadId: m.threadId,
    rfcMessageId,
    inReplyTo,
    references,
    headers: m.headers,
    imageParts: selectInboundImages(m.parts),
    fileParts: files.fetch,
    unfetchedFileParts: files.listOnly,
  };
}

// --- Envelope description (agent run context) ---

/**
 * Human-readable envelope summary for the agent's run context: who else is on
 * the thread and whether the agent was addressed directly (To) or merely copied (Cc).
 * Gives the agent the facts to judge whether a reply is warranted — e.g. to stay
 * quiet on a group thread it wasn't really asked to answer. This is run context,
 * NOT stored in conversation history.
 */
export async function describeEnvelope(email: ReceivedEmail): Promise<string> {
  return summarizeEnvelope({
    from: email.from,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    self: await getSelfAddress(),
  });
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

/** Email address -> team member id, from the roster. */
function teamEmailMap(): Map<string, UserId> {
  return teamLookup("emails");
}

/**
 * Resolve an inbound email to a team identity or fall back to guest.
 *
 * Requires both:
 *   1. `From` address matches DANNY_EMAIL or BETTY_EMAIL (case-insensitive).
 *   2. An Authentication-Results header with spf=pass, dkim=pass, dmarc=pass.
 *
 * Any failure downgrades to guest — we'd rather lose authenticated access
 * than grant it on a spoofed `From`. We parse Gmail's `Authentication-Results`
 * header directly (Gmail stamps it on inbound mail), which is the spoofing
 * defense at the message boundary.
 */
export function resolveEmailIdentity(email: ReceivedEmail): ResolvedIdentity {
  const sender = bareAddress(email.from);
  const userId = teamEmailMap().get(sender);

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
