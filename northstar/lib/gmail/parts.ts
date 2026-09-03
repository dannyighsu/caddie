/**
 * Inbound email MIME parts — discovery and image-selection policy.
 *
 * Pure: no API client, no filesystem. Two jobs, both decided from the payload
 * Gmail already handed us, so nothing is fetched for a message that turns out
 * not to be worth dispatching:
 *
 *   1. {@link extractParts} — which MIME parts are files rather than body text.
 *   2. {@link selectInboundImages} — which of those files are worth showing the
 *      agent. Email attachments are mostly noise (tracking pixels, signature
 *      logos, the image scaffolding of marketing mail), and handing all of it
 *      over would bury the one screenshot somebody actually sent.
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
function isViewableImage(mimeType: string): boolean {
  const type = mimeType.toLowerCase().split(";")[0].trim();
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
};

/**
 * A safe, collision-resistant name for a saved image.
 *
 * Sender-supplied filenames reach us verbatim, so directory components and
 * anything outside a conservative character set are stripped — the name becomes
 * a path under the workspace, and a `../` in it must not escape. The Gmail
 * message id is prefixed because the directory is per *thread*: two messages in
 * one thread both attaching `image.png` would otherwise overwrite each other.
 */
export function safeImageFileName(part: GmailPart, messageId: string, index: number): string {
  const ext = EXT_BY_MIME[part.mimeType.toLowerCase().split(";")[0].trim()] ?? "img";
  const base = (part.fileName.split(/[\\/]/).pop() ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 64);
  const name = base || `image-${index + 1}.${ext}`;
  return `${messageId}-${name.includes(".") ? name : `${name}.${ext}`}`;
}

/** Best-effort mime type for a file we already saved, from its extension. */
export function mimeFromFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
