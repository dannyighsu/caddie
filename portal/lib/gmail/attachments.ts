/**
 * Inbound email attachments — download and workspace storage.
 *
 * The judgment lives next door in ./parts (which MIME parts are files, and
 * which of those are worth handing the agent); this module is the I/O half:
 * fetch the survivors' bytes and write them into the thread's run-artifacts
 * directory, yielding the channel-agnostic {@link Attachment} objects the
 * messaging layer consumes — the same shape Telegram produces.
 */

import { resolve } from "path";
import { readdir, writeFile } from "fs/promises";
import { runArtifactsDir } from "../harness";
import type { Attachment } from "../messaging";
import { getAttachmentBytes } from "./transport";
import {
  isViewableImage,
  mimeFromFileName,
  safeAttachmentFileName,
  type GmailPart,
} from "./parts";

/** Where a thread's inbound attachments live. */
function threadScope(threadId: string): string {
  return `email-${threadId}`;
}

/**
 * Fetch and save the selected parts. `saved` has one {@link Attachment} per
 * file actually written; `failed` has the parts that couldn't be, so the
 * handler can name them to the agent. Individual failures are logged and
 * skipped rather than thrown — a missing file must not cost the agent the
 * message.
 */
export async function downloadInboundAttachments(
  parts: GmailPart[],
  messageId: string,
  threadId: string,
): Promise<{ saved: Attachment[]; failed: GmailPart[] }> {
  const saved: Attachment[] = [];
  const failed: GmailPart[] = [];
  if (parts.length === 0) return { saved, failed };

  const dir = await runArtifactsDir(threadScope(threadId));

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
        failed.push(part);
        continue;
      }

      const fileName = safeAttachmentFileName(part, messageId, index);
      const filePath = resolve(dir, fileName);
      await writeFile(filePath, bytes);
      console.log(
        `[Email Attachments] Saved ${fileName} (${part.mimeType}, ${bytes.length}b) → ${filePath}`,
      );

      saved.push({
        filePath,
        fileName,
        mimeType: part.mimeType,
        isImage: isViewableImage(part.mimeType),
      });
    } catch (err) {
      console.error(
        `[Email Attachments] Failed to save part ${part.partId} of ${messageId}:`,
        err,
      );
      failed.push(part);
    }
  }

  return { saved, failed };
}

/**
 * Every attachment saved for a thread, not just this message's.
 *
 * The messaging layer narrows attachments to those referenced by
 * `[attachment:<fileName>]` markers in the conversation window, so passing the
 * whole thread keeps a file from three replies ago resolvable when the agent
 * re-reads that turn.
 *
 * Scoped to today's run directory (as Telegram's equivalent is), so files from
 * a thread that spans days aren't re-offered on later days — an unresolved
 * marker in old history is simply omitted from the prompt, never an error.
 */
export async function collectThreadAttachments(
  threadId: string,
): Promise<Attachment[]> {
  try {
    const dir = await runArtifactsDir(threadScope(threadId));
    const files = await readdir(dir);
    return files.map((fileName) => {
      const mimeType = mimeFromFileName(fileName);
      return {
        filePath: resolve(dir, fileName),
        fileName,
        mimeType,
        isImage: isViewableImage(mimeType),
      };
    });
  } catch {
    return [];
  }
}
