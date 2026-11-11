/**
 * Inbound Slack files — download and workspace storage.
 *
 * The judgment lives next door in ./slack-files (which uploads are worth
 * handing the agent); this module is the I/O half: fetch the survivors' bytes
 * with the bot token and write them into the thread's run-artifacts directory,
 * yielding the channel-agnostic {@link Attachment} objects the messaging layer
 * consumes — the same shape email and Telegram produce.
 *
 * Needs `files:read` on the bot token. Without it Slack answers the download
 * with its sign-in page (HTTP 200, HTML body) rather than an error, which is
 * why {@link downloadSlackFiles} inspects the content type.
 */

import { resolve } from "path";
import { readdir, writeFile } from "fs/promises";
import { runArtifactsDir } from "./harness";
import type { Attachment } from "./messaging";
import { isViewableImage, mimeFromFileName, safeAttachmentName } from "./mime";
import { fileLabel, fileMimeType, type SlackFile } from "./slack-files";

/** Where a Slack thread's inbound files live. */
function threadScope(channel: string, threadTs: string): string {
  return `slack-${channel}-${threadTs}`;
}

/**
 * Fetch and save the selected files. `saved` has one {@link Attachment} per
 * file actually written; `failed` pairs each file that couldn't be with why, so
 * the handler can name it to the agent. Individual failures are logged and
 * skipped rather than thrown — a missing file must not cost the agent the
 * message.
 */
export async function downloadSlackFiles(
  files: SlackFile[],
  channel: string,
  threadTs: string,
): Promise<{ saved: Attachment[]; failed: { file: SlackFile; reason: string }[] }> {
  const saved: Attachment[] = [];
  const failed: { file: SlackFile; reason: string }[] = [];
  if (files.length === 0) return { saved, failed };

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    return { saved, failed: files.map((file) => ({ file, reason: "Slack is not configured" })) };
  }

  const dir = await runArtifactsDir(threadScope(channel, threadTs));

  for (const [index, file] of files.entries()) {
    const url = file.url_private_download || file.url_private;
    if (!url) {
      failed.push({ file, reason: "no download URL in the Slack event" });
      continue;
    }
    try {
      const bytes = await fetchFileBytes(url, token, fileMimeType(file));
      const mimeType = fileMimeType(file);
      // The file id is the prefix: the directory is per *thread*, so two
      // uploads of `Screenshot.png` must not overwrite each other.
      const fileName = safeAttachmentName(
        file.name ?? file.title ?? "",
        mimeType,
        file.id ?? String(index + 1),
        index,
      );
      const filePath = resolve(dir, fileName);
      await writeFile(filePath, bytes);
      console.log(
        `[Slack Files] Saved ${fileName} (${mimeType}, ${bytes.length}b) → ${filePath}`,
      );
      saved.push({ filePath, fileName, mimeType, isImage: isViewableImage(mimeType) });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[Slack Files] Failed to save ${fileLabel(file)}: ${reason}`);
      failed.push({ file, reason });
    }
  }

  return { saved, failed };
}

/**
 * Download one file's bytes with the bot token.
 *
 * A token without `files:read` doesn't get an error from these URLs — Slack
 * serves its sign-in page with HTTP 200 — so an HTML body for a file that
 * isn't HTML is treated as the auth failure it is, with the fix named.
 */
async function fetchFileBytes(url: string, token: string, mimeType: string): Promise<Buffer> {
  const res = await globalThis.fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "follow",
  });
  if (!res.ok) {
    throw new Error(`download failed (HTTP ${res.status})`);
  }
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/html") && !mimeType.includes("html")) {
    throw new Error(
      "Slack returned its sign-in page instead of the file — the bot token likely " +
        "lacks the files:read scope (add it under OAuth & Permissions and reinstall the app)",
    );
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error("download returned no bytes");
  return bytes;
}

/**
 * Every file saved for a Slack thread, not just this message's.
 *
 * The messaging layer narrows attachments to those referenced by
 * `[attachment:<fileName>]` markers in the conversation window, so passing the
 * whole thread keeps a file from three replies ago resolvable when the agent
 * re-reads that turn.
 *
 * Scoped to today's run directory (as email's and Telegram's equivalents are),
 * so files from a thread that spans days aren't re-offered on later days — an
 * unresolved marker in old history is simply omitted from the prompt, never an
 * error.
 */
export async function collectThreadSlackFiles(
  channel: string,
  threadTs: string,
): Promise<Attachment[]> {
  try {
    const dir = await runArtifactsDir(threadScope(channel, threadTs));
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
