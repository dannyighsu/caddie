/**
 * MIME and saved-filename helpers, shared by every inbound channel that writes
 * attachments into the workspace (email, Slack).
 *
 * Pure: no API client, no filesystem. The per-channel modules decide *which*
 * files are worth keeping; this is the vocabulary they agree on — what counts
 * as an image the agent can look at, what extension a type gets, and how a
 * sender-supplied name is made safe to use as a path.
 */

/** Lower-cased mime type without parameters (`; charset=…`). */
export function baseMime(mimeType: string): string {
  return mimeType.toLowerCase().split(";")[0].trim();
}

/**
 * Viewable raster images only. SVG is excluded on purpose: it's markup that can
 * carry script, and it isn't something the agent can view as an image anyway.
 */
export function isViewableImage(mimeType: string): boolean {
  const type = baseMime(mimeType);
  return type.startsWith("image/") && type !== "image/svg+xml";
}

/** "1.2 MB"-style size for the agent's run context. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

/** Extension for a mime type: the known one, else `img`/`bin` by class. */
export function extFromMime(mimeType: string): string {
  const type = baseMime(mimeType);
  return EXT_BY_MIME[type] ?? (type.startsWith("image/") ? "img" : "bin");
}

/** Best-effort mime type for a file we already saved, from its extension. */
export function mimeFromFileName(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

/**
 * A safe, collision-resistant name for a saved attachment.
 *
 * Sender-supplied filenames reach us verbatim, so directory components and
 * anything outside a conservative character set are stripped — the name becomes
 * a path under the workspace, and a `../` in it must not escape. `prefix` (a
 * message or file id) is prepended because the directory is per *thread*: two
 * messages in one thread both attaching `image.png` would otherwise overwrite
 * each other.
 */
export function safeAttachmentName(
  rawName: string,
  mimeType: string,
  prefix: string,
  index: number,
): string {
  const ext = extFromMime(mimeType);
  const isImage = baseMime(mimeType).startsWith("image/");
  const base = (rawName.split(/[\\/]/).pop() ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^[.-]+/, "")
    .slice(0, 64);
  const name = base || `${isImage ? "image" : "file"}-${index + 1}.${ext}`;
  return `${prefix}-${name.includes(".") ? name : `${name}.${ext}`}`;
}
