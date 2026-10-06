/**
 * Inbound Slack files — discovery and selection policy.
 *
 * Pure: no API client, no filesystem. Slack delivers uploads as a `files` array
 * on the message event, carrying metadata and a private URL rather than bytes,
 * so what's worth downloading is decided here from the payload Slack already
 * handed us — nothing is fetched for a file we wouldn't hand over anyway. The
 * I/O half lives next door in ./slack-attachments.
 *
 * Unlike email, a Slack upload is never chrome: there are no tracking pixels or
 * signature logos in a `files` array, so images aren't size-filtered the way
 * ./gmail/parts filters them — someone who drops a screenshot in a thread means
 * it. Only the undownloadable and the outsized are held back, and those are
 * still named to the agent rather than dropped.
 */

import { formatBytes, mimeFromFileName } from "./mime.ts";

/**
 * The fields of a Slack file object this path uses. Slack sends many more; the
 * event payload is untrusted shape-wise, so everything is optional.
 */
export interface SlackFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  size?: number;
  /** Authenticated download URL (bot token as a bearer credential). */
  url_private_download?: string;
  url_private?: string;
  /**
   * `hosted`/`snippet` are on Slack's own storage. `tombstone` is a deleted
   * file, `hidden_by_limit` one the workspace's retention has put behind a
   * paywall; neither has bytes. `external` is a link to Drive/Box/etc.
   */
  mode?: string;
  is_external?: boolean;
}

/** Largest file fetched into the workspace. Slack's own upload cap is 1GB. */
const MAX_FILE_BYTES = envInt("SLACK_MAX_FILE_BYTES", 25 * 1024 * 1024);

/** More than this in one message is unusual enough that the rest are listed, not fetched. */
const MAX_FILES_PER_MESSAGE = envInt("SLACK_MAX_FILES", 10);

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** How a file is described to the agent when it couldn't be handed over. */
export function unretrievedNotice(file: SlackFile, reason: string): string {
  const type = fileMimeType(file);
  const size = typeof file.size === "number" ? `, ${formatBytes(file.size)}` : "";
  return `[attachment not retrieved: ${fileLabel(file)} (${type}${size}) — ${reason}]`;
}

/** The name to show for a file, falling back to its title and then its id. */
export function fileLabel(file: SlackFile): string {
  return file.name || file.title || file.id || "(unnamed)";
}

/**
 * Best-effort mime type. Slack usually sends `mimetype`; when it doesn't, the
 * filename is a better guess than `filetype` (which is Slack's own vocabulary,
 * e.g. "quip", not a mime type).
 */
export function fileMimeType(file: SlackFile): string {
  return file.mimetype || mimeFromFileName(file.name ?? "");
}

/**
 * Split an event's files into what to download and what to merely name.
 *
 * `fetch` is downloadable; `listOnly` pairs each held-back file with the reason
 * the agent should be told. An external file (a Drive link shared into the
 * channel) has no bytes on Slack at all, and a tombstoned or retention-hidden
 * one no longer does — those are named, never fetched, because an agent that
 * silently sees nothing tells the sender their file never arrived.
 */
export function selectInboundSlackFiles(files: SlackFile[]): {
  fetch: SlackFile[];
  listOnly: { file: SlackFile; reason: string }[];
} {
  const fetch: SlackFile[] = [];
  const listOnly: { file: SlackFile; reason: string }[] = [];
  const seen = new Set<string>();

  for (const file of files) {
    // The same file can appear twice when it's shared into a thread it was
    // already posted in; the id dedupes it.
    if (file.id) {
      if (seen.has(file.id)) continue;
      seen.add(file.id);
    }
    if (file.mode === "tombstone") {
      listOnly.push({ file, reason: "deleted from Slack" });
    } else if (file.mode === "hidden_by_limit") {
      listOnly.push({ file, reason: "hidden by the workspace's file limit" });
    } else if (file.is_external || file.mode === "external") {
      listOnly.push({ file, reason: "an external link, not a file on Slack" });
    } else if (!(file.url_private_download || file.url_private)) {
      listOnly.push({ file, reason: "no download URL in the Slack event" });
    } else if (typeof file.size === "number" && file.size > MAX_FILE_BYTES) {
      listOnly.push({ file, reason: "too large to download" });
    } else if (fetch.length >= MAX_FILES_PER_MESSAGE) {
      listOnly.push({ file, reason: "past the per-message attachment limit" });
    } else {
      fetch.push(file);
    }
  }

  return { fetch, listOnly };
}
