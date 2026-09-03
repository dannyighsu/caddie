/**
 * Inbound email images — download and workspace storage.
 *
 * The judgment lives next door in ./parts (which MIME parts are files, and
 * which of those are worth showing the agent); this module is the I/O half:
 * fetch the survivors' bytes and write them into the thread's run-artifacts
 * directory, yielding the channel-agnostic {@link Attachment} objects the
 * messaging layer consumes — the same shape Telegram produces.
 */

import { resolve } from "path";
import { readdir, writeFile } from "fs/promises";
import { runArtifactsDir } from "../harness";
import type { Attachment } from "../messaging";
import { getAttachmentBytes } from "./transport";
import { mimeFromFileName, safeImageFileName, type GmailPart } from "./parts";

/** Where a thread's inbound images live. */
function threadScope(threadId: string): string {
  return `email-${threadId}`;
}

/**
 * Fetch and save the selected images, returning one {@link Attachment} per file
 * actually written. Individual failures are logged and skipped rather than
 * thrown — a missing image must not cost the agent the message.
 */
export async function downloadInboundImages(
  parts: GmailPart[],
  messageId: string,
  threadId: string,
  agentId: string,
): Promise<Attachment[]> {
  if (parts.length === 0) return [];

  const dir = await runArtifactsDir(agentId, threadScope(threadId));
  const saved: Attachment[] = [];

  for (const [index, part] of parts.entries()) {
    try {
      const bytes = part.data
        ? Buffer.from(part.data, "base64url")
        : part.attachmentId
          ? await getAttachmentBytes(messageId, part.attachmentId)
          : null;
      if (!bytes || bytes.length === 0) {
        console.warn(
          `[Email Attachments] No bytes for part ${part.partId} of ${messageId} — skipping`,
        );
        continue;
      }

      const fileName = safeImageFileName(part, messageId, index);
      const filePath = resolve(dir, fileName);
      await writeFile(filePath, bytes);
      console.log(
        `[Email Attachments] Saved ${fileName} (${part.mimeType}, ${bytes.length}b) → ${filePath}`,
      );

      saved.push({ filePath, fileName, mimeType: part.mimeType, isImage: true });
    } catch (err) {
      console.error(
        `[Email Attachments] Failed to save part ${part.partId} of ${messageId}:`,
        err,
      );
    }
  }

  return saved;
}

/**
 * Every image saved for a thread, not just this message's.
 *
 * The messaging layer narrows attachments to those referenced by
 * `[attachment:<fileName>]` markers in the conversation window, so passing the
 * whole thread keeps an image from three replies ago resolvable when the agent
 * re-reads that turn.
 *
 * Scoped to today's run directory (as Telegram's equivalent is), so images from
 * a thread that spans days aren't re-offered on later days — an unresolved
 * marker in old history is simply omitted from the prompt, never an error.
 */
export async function collectThreadImages(
  agentId: string,
  threadId: string,
): Promise<Attachment[]> {
  try {
    const dir = await runArtifactsDir(agentId, threadScope(threadId));
    const files = await readdir(dir);
    return files.map((fileName) => ({
      filePath: resolve(dir, fileName),
      fileName,
      mimeType: mimeFromFileName(fileName),
      isImage: true,
    }));
  } catch {
    return [];
  }
}
