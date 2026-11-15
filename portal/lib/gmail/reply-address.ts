/**
 * Reply addressing (pure, dependency-free).
 *
 * Who a reply goes to, and the threading headers that put it in the right
 * conversation, are derived here from the headers of the message being replied
 * to. Kept free of I/O and of the Gmail client so the rules can be unit-tested
 * directly — they are the part of the send path that, when wrong, delivers
 * private mail to the wrong person.
 */

export interface ParsedAddress {
  name?: string;
  email: string;
}

/** Parse a "Name <a@b>, c@d" header field into individual addresses. */
export function parseEmailAddresses(field: string | undefined): ParsedAddress[] {
  if (!field) return [];
  return field
    .split(",")
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((token) => {
      const m = token.match(/^(.*?)\s*<([^>]+)>$/);
      if (m) return { name: m[1].replace(/^"|"$/g, "").trim() || undefined, email: m[2].trim() };
      return { email: token.trim() };
    })
    .filter((a) => a.email);
}

/** Case-insensitive header lookup over a raw header map. */
export function getHeaderCI(headers: Record<string, string>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target && v) return v;
  }
  return undefined;
}

export interface ReplyContext {
  to: string;
  cc?: string;
  inReplyTo?: string;
  references?: string;
  subject?: string;
}

/**
 * Pick the message a reply should be addressed from.
 *
 * `anchorId` names the message actually being replied to (the inbound message
 * the run is handling). Addressing MUST come from that message, not from
 * whatever happens to sit last in the thread: a thread can gain messages
 * between the inbound arriving and the reply going out — including sends by
 * this agent itself, earlier in the same run — and anchoring on the last
 * message then silently redirects the reply to that message's correspondent.
 * See the "Hi Betty" incident: a team member's 1:1 reply was answered to the
 * vendor on the thread, because the run had emailed the vendor moments before.
 *
 * Falls back to the last message when no anchor is given (the follow-up path,
 * which is addressed by its caller anyway) or when the anchor is not in the
 * thread.
 */
export function selectReplyAnchor<T extends { id?: string | null }>(
  messages: readonly T[],
  anchorId?: string,
): T | undefined {
  if (messages.length === 0) return undefined;
  if (anchorId) {
    const found = messages.find((m) => m.id === anchorId);
    if (found) return found;
    console.warn(
      `[Gmail] reply anchor ${anchorId} not found in thread — falling back to the last message`,
    );
  }
  return messages[messages.length - 1];
}

/**
 * Build recipients + threading headers from the anchor message's own headers.
 * Pure, so the addressing rules can be unit-tested without the Gmail API.
 */
export function buildReplyContext(input: {
  /** Headers of the message being replied to. */
  anchorHeaders: Record<string, string>;
  /** Subject of the thread's first message (used for the `Re:` subject). */
  threadSubject?: string;
  selfEmail: string;
  replyAll: boolean;
}): ReplyContext {
  const { anchorHeaders: headers, threadSubject, selfEmail, replyAll } = input;
  const selfLower = selfEmail.toLowerCase();

  const fromField = getHeaderCI(headers, "From") ?? "";
  const anchorFromSelf = parseEmailAddresses(fromField).some(
    (a) => a.email.toLowerCase() === selfLower,
  );

  // To: reply to the sender, unless the anchor was ours (then to its recipients).
  const to = anchorFromSelf ? getHeaderCI(headers, "To") ?? "" : fromField;

  let cc: string | undefined;
  if (replyAll) {
    const seen = new Set(parseEmailAddresses(to).map((a) => a.email.toLowerCase()));
    seen.add(selfLower);
    const ccSources = anchorFromSelf
      ? [getHeaderCI(headers, "Cc")]
      : [getHeaderCI(headers, "To"), getHeaderCI(headers, "Cc")];
    const candidates: string[] = [];
    for (const field of ccSources) {
      for (const addr of parseEmailAddresses(field)) {
        const key = addr.email.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(addr.name ? `${addr.name} <${addr.email}>` : addr.email);
      }
    }
    if (candidates.length > 0) cc = candidates.join(", ");
  }

  const subject = threadSubject
    ? threadSubject.toLowerCase().startsWith("re:")
      ? threadSubject
      : `Re: ${threadSubject}`
    : undefined;

  const messageId = getHeaderCI(headers, "Message-ID");
  const existingRefs = getHeaderCI(headers, "References");
  return {
    to,
    cc,
    subject,
    inReplyTo: messageId,
    references: messageId ? (existingRefs ? `${existingRefs} ${messageId}` : messageId) : existingRefs,
  };
}
