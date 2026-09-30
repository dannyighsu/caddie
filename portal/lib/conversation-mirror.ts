/**
 * Conversation mirror: one markdown file per conversation message, in the
 * agent's workspace, for the local search index.
 *
 *   <workspace>/conversations/<channel>/<conversation-id>/<seq>.md
 *
 * Postgres stays the source of truth. The mirror is derived and rebuildable,
 * and the agent never edits it. A message's content never changes once
 * appended, so each file is written once. The exception is a purge, which
 * deletes the file (lib/purge.ts).
 *
 * Mirroring is best-effort: a failed write is logged and repaired by the
 * startup backfill, and never fails the message handling that triggered it.
 */

import { mkdir, readdir, rename, rm, stat, writeFile } from "fs/promises";
import { dirname, resolve } from "path";
import { defaultWorkspaceRoot } from "@ignis/harness";
import { senderLabel } from "./conversation-history";
import { getConversation, listAgentConversations, type Conversation } from "./db";
import { CONVERSATIONS_DIR, messageRelPath, renderMessageFile } from "./rag-files";
import { MIRROR_SYNC_DEBOUNCE_MS, requestIndexSync } from "./workspace-index";

export function agentWorkspace(agentId: string): string {
  return resolve(defaultWorkspaceRoot(), agentId);
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // The temp name has no indexed extension, so a sync never picks it up.
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

async function writeMessage(workspace: string, conv: Conversation, seq: number): Promise<void> {
  const msg = conv.messages[seq];
  if (!msg || msg.purged) return;
  await writeAtomic(resolve(workspace, messageRelPath(conv, seq)), renderMessageFile(conv, seq, msg, senderLabel(msg)));
}

/**
 * Mirror messages just appended to a conversation (called by `appendMessages`
 * after its write commits), then nudge the indexer.
 */
export async function mirrorAppended(
  agentId: string,
  conversationId: string,
  startSeq: number,
  count: number
): Promise<void> {
  const conv = await getConversation(conversationId);
  if (!conv) return;
  const workspace = agentWorkspace(agentId);
  for (let seq = startSeq; seq < startSeq + count; seq++) {
    await writeMessage(workspace, conv, seq);
  }
  requestIndexSync(agentId, MIRROR_SYNC_DEBOUNCE_MS);
}

/** Delete one message's mirror file (purge). Returns its workspace-relative path. */
export async function removeMirroredMessage(
  agentId: string,
  conv: Pick<Conversation, "id" | "external_id">,
  seq: number
): Promise<string> {
  const rel = messageRelPath(conv, seq);
  await rm(resolve(agentWorkspace(agentId), rel), { force: true });
  return rel;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every file under `dir`, workspace-relative, skipping links. */
async function listFiles(workspace: string, relDir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(resolve(workspace, relDir), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of entries) {
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await listFiles(workspace, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/**
 * Make the mirror match Postgres. Writes every missing, non-purged message and
 * deletes every file whose message is purged or gone (including leftovers
 * from a crashed atomic write). Runs at startup, before the first index sync.
 */
export async function backfillMirror(agentId: string): Promise<void> {
  const workspace = agentWorkspace(agentId);
  const conversations = await listAgentConversations(agentId);
  const expected = new Set<string>();
  let written = 0;

  for (const conv of conversations) {
    for (let seq = 0; seq < conv.messages.length; seq++) {
      if (conv.messages[seq].purged) continue;
      const rel = messageRelPath(conv, seq);
      expected.add(rel);
      if (!(await exists(resolve(workspace, rel)))) {
        try {
          await writeMessage(workspace, conv, seq);
          written++;
        } catch (err) {
          console.error(`[Mirror:${agentId}] failed to write ${rel}:`, err);
        }
      }
    }
  }

  let removed = 0;
  for (const rel of await listFiles(workspace, CONVERSATIONS_DIR)) {
    if (expected.has(rel)) continue;
    await rm(resolve(workspace, rel), { force: true });
    removed++;
  }

  if (written || removed) {
    console.log(`[Mirror:${agentId}] backfill: ${written} written, ${removed} removed (${conversations.length} conversations)`);
  }
}
