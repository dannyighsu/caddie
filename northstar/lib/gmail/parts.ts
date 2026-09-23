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
 * Viewable raster images only. SVG is excluded on purpose: it's markup that can
 * carry script, and it isn't something the agent can view as an image anyway.
 */
export function isViewableImage(mimeType: string): boolean {
  const type = baseMime(mimeType);
  return type.startsWith("image/") && type !== "image/svg+xml";
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

/** Lower-cased mime type without parameters (`; charset=…`). */
function baseMime(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0].trim();
}

/** "1.2 MB"-style size for the agent's run context. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// --- Filenames ---

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
  "text/calendar": "ics",
  "text/csv": "csv",
  "text/plain": "txt",
  "application/zip": "zip",
  "message/rfc822": "eml",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
};

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  pdf: "application/pdf",
  ics: "text/calendar",
  csv: "text/csv",
  txt: "text/plain",
  zip: "application/zip",
  eml: "message/rfc822",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * A safe, collision-resistant name for a saved attachment.
 *
 * Sender-supplied filenames reach us verbatim, so directory components and
 * anything outside a conservative character set are stripped — the name becomes
 * a path under the workspace, and a `../` in it must not escape. The Gmail
 * message id is prefixed because the directory is per *thread*: two messages in
 * one thread both attaching `image.png` would otherwise overwrite each other.
 */
export function safeAttachmentFileName(part: GmailPart, messageId: string, index: number): string {
  const type = baseMime(part.mimeType);
  const isImage = type.startsWith("image/");
  const ext = EXT_BY_MIME[type] ?? (isImage ? "img" : "bin");
  const base = (part.fileName.split(/[\\/]/).pop() ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 64);
  const name = base || `${isImage ? "image" : "file"}-${index + 1}.${ext}`;
  return `${messageId}-${name.includes(".") ? name : `${name}.${ext}`}`;
}

/** Best-effort mime type for a file we already saved, from its extension. */
export function mimeFromFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
