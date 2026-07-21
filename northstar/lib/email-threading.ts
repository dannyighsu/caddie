/**
 * Email threading heuristics (pure, dependency-free).
 *
 * The AgentMail webhook delivers a single inbound message plus thread metadata —
 * never the full thread. It also offers `extracted_text`, the message body with
 * quoted/forwarded history stripped. That stripping is the right default for an
 * ongoing back-and-forth (the agent already holds the prior turns), but it is
 * exactly wrong when a message *carries* history the agent has not otherwise
 * seen — a forward, or a reply that loops the agent into a conversation that
 * happened off its inbox.
 *
 * This module decides, per inbound message, whether to feed the agent the
 * stripped body (`extracted`) or the full body *with* quoted history. It is
 * deliberately free of I/O and app imports so the branching logic can be
 * exhaustively unit- and stress-tested in isolation.
 *
 * Identifier note: threading here works in RFC 5322 `Message-ID` space
 * (`<local@domain>`) — the ids carried by `In-Reply-To`/`References` — NOT
 * AgentMail's opaque `message_id`. The two are different id spaces; callers MUST
 * populate `knownMessageIds` from RFC `Message-ID` header values (normalized via
 * {@link normalizeMessageId}) for gap detection to be meaningful.
 */

/** Why a given body was chosen — surfaced for logging and tested directly. */
export type InboundBodyReason =
  | "forward"
  | "loop-in"
  | "gap"
  | "normal"
  | "empty";

export interface InboundBodyInput {
  /** Body with quoted reply history stripped (AgentMail `extracted_text`). */
  extractedText: string;
  /** Full body *including* any quoted/forwarded history. */
  fullText: string;
  /** Whether the message is a forward (subject/body markers). */
  isForward: boolean;
  /**
   * Normalized RFC `Message-ID` this message replies to (`In-Reply-To`), if any.
   * Undefined for thread-opening messages.
   */
  inReplyTo?: string;
  /** Whether a local conversation already exists for this thread. */
  threadKnownLocally: boolean;
  /**
   * Normalized RFC `Message-ID`s the agent has already seen or sent in this
   * thread. Used to tell a direct reply (parent is known) apart from a reply
   * whose parent we never saw (an off-inbox side conversation).
   */
  knownMessageIds: ReadonlySet<string>;
}

export interface InboundBodySelection {
  /** The body text to hand to the agent. */
  body: string;
  /** Whether quoted/forwarded history was deliberately included. */
  includedHistory: boolean;
  /** The rule that fired. */
  reason: InboundBodyReason;
}

/**
 * Strip surrounding angle brackets and outer whitespace from an RFC
 * `Message-ID` so ids compare consistently regardless of whether a given header
 * carried them bracketed. Applied on both sides of every comparison — to parsed
 * `In-Reply-To`/`References` ids and to the ids callers store as "seen".
 *
 * Note: RFC 5322 treats the id as case-sensitive, so casing is preserved.
 */
export function normalizeMessageId(raw: string): string {
  return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * Extract normalized RFC `Message-ID`s from an `In-Reply-To`/`References`-style
 * header value. Prefers explicit `<...>` tokens; falls back to whitespace
 * splitting for the rare sender that omits brackets. Empty tokens are dropped.
 */
function extractMessageIds(raw: string | undefined): string[] {
  if (!raw) return [];
  const bracketed = raw.match(/<[^<>]*>/g);
  const tokens = bracketed ?? raw.split(/\s+/);
  const ids: string[] = [];
  for (const t of tokens) {
    const id = normalizeMessageId(t);
    if (id) ids.push(id);
  }
  return ids;
}

/** Case-insensitive header lookup over a raw header map. */
function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target && v) return v;
  }
  return undefined;
}

export interface MessageRefs {
  /** The single parent id (`In-Reply-To`), if present. */
  inReplyTo?: string;
  /** The full ancestry chain (`References`), oldest→newest, normalized. */
  references: string[];
}

/**
 * Parse `In-Reply-To` and `References` from raw RFC 5322 headers into normalized
 * `Message-ID`s. `In-Reply-To` should carry exactly one id; if malformed with
 * several, the last (nearest ancestor) wins.
 */
export function parseMessageRefs(
  headers: Record<string, string>,
): MessageRefs {
  const references = extractMessageIds(getHeader(headers, "References"));
  const inReplyToIds = extractMessageIds(getHeader(headers, "In-Reply-To"));
  const inReplyTo =
    inReplyToIds.length > 0
      ? inReplyToIds[inReplyToIds.length - 1]
      : // Some clients omit In-Reply-To but populate References; the nearest
        // ancestor is the last References entry.
        references.length > 0
        ? references[references.length - 1]
        : undefined;
  return { inReplyTo, references };
}

// Unambiguous forward markers. "-----Original Message-----" is intentionally
// excluded: Outlook emits it for ordinary replies too, so keying on it would
// re-surface quoted history on every normal reply.
const FORWARD_SUBJECT = /^\s*fwd?\s*:/i;
const FORWARD_BODY_MARKERS: RegExp[] = [
  // Gmail / most webmail: "---------- Forwarded message ---------"
  /^[>|\s]*-{2,}\s*forwarded message\s*-{2,}/im,
  // Apple Mail: "Begin forwarded message:"
  /^[>|\s]*begin forwarded message:/im,
];

/**
 * Detect whether an inbound message is a forward, via its subject prefix
 * (`Fwd:`/`Fw:`) or a recognizable forwarded-message banner in the body. Quote
 * markers (`>`/`|`) may precede a body banner, so nested forwards still match.
 */
export function isForwardedMessage(subject: string, body: string): boolean {
  if (FORWARD_SUBJECT.test(subject ?? "")) return true;
  const b = body ?? "";
  return FORWARD_BODY_MARKERS.some((re) => re.test(b));
}

/** First argument with non-whitespace content, else "". */
function firstNonEmpty(...vals: (string | undefined)[]): string {
  for (const v of vals) {
    if (v && v.trim()) return v;
  }
  return "";
}

/**
 * Decide which body to hand the agent for an inbound message.
 *
 * History is included when the message brings context the agent would otherwise
 * lack, in priority order:
 *   1. `forward`  — the quoted content *is* the payload.
 *   2. `loop-in`  — a reply into a thread we hold no local record of; the quoted
 *                   history is the only trace of what came before.
 *   3. `gap`      — a reply on a known thread whose parent we never saw, i.e.
 *                   messages happened off our inbox (a side conversation).
 * Otherwise (`normal`) the stripped body is correct — the prior turns already
 * live in local history and re-feeding them is noise.
 *
 * Body resolution never returns empty when *any* candidate has content: the
 * chosen variant falls back to the other so a blank `extracted`/`full` never
 * drops a real message.
 */
export function selectInboundBody(
  input: InboundBodyInput,
): InboundBodySelection {
  const {
    extractedText,
    fullText,
    isForward,
    inReplyTo,
    threadKnownLocally,
    knownMessageIds,
  } = input;

  let reason: InboundBodyReason;
  if (isForward) {
    reason = "forward";
  } else if (inReplyTo && !threadKnownLocally) {
    reason = "loop-in";
  } else if (inReplyTo && !knownMessageIds.has(inReplyTo)) {
    reason = "gap";
  } else {
    reason = "normal";
  }

  const includeHistory = reason !== "normal";
  const body = includeHistory
    ? firstNonEmpty(fullText, extractedText)
    : firstNonEmpty(extractedText, fullText);

  if (!body.trim()) {
    return { body: "", includedHistory: false, reason: "empty" };
  }
  return { body, includedHistory: includeHistory, reason };
}
