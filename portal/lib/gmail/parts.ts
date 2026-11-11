/**
 * Inbound email MIME parts — discovery and selection policy.
 *
 * Pure: no API client, no filesystem. Two jobs, both decided from the payload
 * Gmail already handed us, so nothing is fetched for a message that turns out
 * not to be worth dispatching:
 *
 *   1. {@link extractParts} — which MIME parts are files rather than body text.
 *   2. {@link selectInboundImages} / {@link selectInboundFiles} — which of those
 *      files are worth handing the agent. Email *images* are mostly noise
 *      (tracking pixels, signature logos, the image scaffolding of marketing
 *      mail), so they are filtered hard. Every other file — a PDF, a contract,
 *      a spreadsheet — is something a person deliberately attached, so it is
 *      kept, and one too large to fetch is still reported rather than dropped:
 *      an agent that can't see an attachment will tell the sender it never came.
 *
 * Images referenced by remote URL in an HTML body are deliberately out of scope:
 * those are the tracking-beacon vector, and retrieving one tells the sender the
 * mail was opened.
 */

import type { gmail_v1 } from "googleapis";
import { baseMime, isViewableImage, safeAttachmentName } from "../mime.ts";

// Re-exported so callers keep reaching email's own vocabulary through ./parts.
export { formatBytes, isViewableImage, mimeFromFileName } from "../mime.ts";

/** Case-insensitive lookup of one header on a single MIME part. */
function partHeader(p: gmail_v1.Schema$MessagePart, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const h of p.headers ?? []) {
    if (h.name?.toLowerCase() === target && h.value) return h.value;
  }
  return undefined;
}

/** A non-body MIME part: an attached file, or an inline `cid:` one. */
export interface GmailPart {
  /** Gmail's part id within this message's payload. */
  partId: string;
  /** Filename from the part headers; "" when the part is unnamed. */
  fileName: string;
  mimeType: string;
  /** Byte size as reported by Gmail (before base64 encoding). */
  sizeBytes: number;
  /** Fetch handle for the bytes; absent when the part inlines its own data. */
  attachmentId?: string;
  /** Base64url bytes, present only on the small parts Gmail inlines. */
  data?: string;
  /** Rendered inside the body (a pasted screenshot, a signature logo). */
  inline: boolean;
}

/**
 * Collect a message's non-body parts — attached files and inline `cid:` ones.
 *
 * Multipart containers and the body parts `extractBodies` takes (unnamed
 * text/plain and text/html) are skipped; every other leaf with bytes behind it
 * is a file. Metadata only — the bytes come from `getAttachmentBytes` in
 * ./transport, so callers can decide what's worth fetching before paying.
 */
export function extractParts(root: gmail_v1.Schema$MessagePart | undefined): GmailPart[] {
  const out: GmailPart[] = [];
  if (!root) return out;

  const walk = (p: gmail_v1.Schema$MessagePart) => {
    const mimeType = p.mimeType ?? "";
    const fileName = p.filename ?? "";
    const isContainer = (p.parts?.length ?? 0) > 0 || mimeType.startsWith("multipart/");
    const isBody = !fileName && (mimeType === "text/plain" || mimeType === "text/html");
    const attachmentId = p.body?.attachmentId ?? undefined;
    const data = p.body?.data ?? undefined;

    if (!isContainer && !isBody && (attachmentId || data)) {
      const disposition = (partHeader(p, "Content-Disposition") ?? "").trim();
      const contentId = partHeader(p, "Content-ID");
      out.push({
        partId: p.partId ?? String(out.length),
        fileName,
        mimeType,
        sizeBytes: p.body?.size ?? 0,
        attachmentId,
        data,
        // A Content-ID with no explicit disposition means the body references
        // the part — Gmail composes pasted images that way.
        inline: /^inline/i.test(disposition) || (!!contentId && !/^attachment/i.test(disposition)),
      });
    }

    for (const sub of p.parts ?? []) walk(sub);
  };

  walk(root);
  return out;
}

// --- Policy ---

/**
 * Below this, an image is chrome rather than content: a 1x1 tracking pixel is
 * ~43 bytes and a signature logo a few KB, while a real screenshot or photo is
 * comfortably larger. Tunable — the right cutoff depends on who mails you.
 */
const MIN_IMAGE_BYTES = envInt("EMAIL_MIN_IMAGE_BYTES", 8 * 1024);

/** Skip anything larger; Gmail caps messages at 25MB, and this bounds the workspace. */
const MAX_IMAGE_BYTES = envInt("EMAIL_MAX_IMAGE_BYTES", 10 * 1024 * 1024);

/** Newsletters carry dozens of images; keep the substantive few. */
const MAX_IMAGES_PER_MESSAGE = envInt("EMAIL_MAX_IMAGES", 5);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Pick the images worth showing the agent, largest-first when over the cap but
 * returned in the message's own order so they line up with the body text.
 *
 * Inline and attached images are treated alike — a screenshot pasted into Gmail
 * arrives inline with a `cid:`, and is exactly what someone means by "see the
 * image" — so size, not disposition, does the filtering.
 */
export function selectInboundImages(parts: GmailPart[]): GmailPart[] {
  const eligible = parts.filter(
    (p) =>
      isViewableImage(p.mimeType) &&
      p.sizeBytes >= MIN_IMAGE_BYTES &&
      p.sizeBytes <= MAX_IMAGE_BYTES,
  );
  if (eligible.length <= MAX_IMAGES_PER_MESSAGE) return eligible;

  const keep = new Set(
    [...eligible]
      .sort((a, b) => b.sizeBytes - a.sizeBytes)
      .slice(0, MAX_IMAGES_PER_MESSAGE)
      .map((p) => p.partId),
  );
  return eligible.filter((p) => keep.has(p.partId));
}

/** Largest non-image file fetched into the workspace; Gmail itself caps messages at 25MB. */
const MAX_FILE_BYTES = envInt("EMAIL_MAX_FILE_BYTES", 25 * 1024 * 1024);

/** More than this in one message is unusual enough that the rest are listed, not fetched. */
const MAX_FILES_PER_MESSAGE = envInt("EMAIL_MAX_FILES", 10);

/**
 * MIME types that ride along as parts but aren't anything a person attached:
 * S/MIME and PGP signatures, and the delivery-status machinery of bounces.
 */
const NON_CONTENT_TYPES = new Set([
  "application/pkcs7-signature",
  "application/x-pkcs7-signature",
  "application/pgp-signature",
  "application/pgp-keys",
  "message/delivery-status",
  "message/disposition-notification",
]);

/**
 * Pick the non-image files worth handing the agent.
 *
 * `fetch` is what to download; `listOnly` is what was attached but won't be
 * fetched (too large, or past the per-message cap). The handler reports the
 * latter by name so the agent can say "I see report.pdf but couldn't open it"
 * instead of "nothing arrived".
 *
 * Images are left to {@link selectInboundImages} — including the small ones it
 * drops, which are chrome rather than something the sender meant to send.
 */
export function selectInboundFiles(parts: GmailPart[]): {
  fetch: GmailPart[];
  listOnly: GmailPart[];
} {
  const fetch: GmailPart[] = [];
  const listOnly: GmailPart[] = [];
  for (const p of parts) {
    const type = baseMime(p.mimeType);
    if (type.startsWith("image/") || NON_CONTENT_TYPES.has(type)) continue;
    if (p.sizeBytes > MAX_FILE_BYTES || fetch.length >= MAX_FILES_PER_MESSAGE) {
      listOnly.push(p);
    } else {
      fetch.push(p);
    }
  }
  return { fetch, listOnly };
}

// --- Filenames ---

/**
 * A safe, collision-resistant name for a saved attachment. The Gmail message id
 * is the prefix because the directory is per *thread*. See ../mime.
 */
export function safeAttachmentFileName(part: GmailPart, messageId: string, index: number): string {
  return safeAttachmentName(part.fileName, part.mimeType, messageId, index);
}
