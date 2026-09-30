/**
 * Purge: remove content that looks like phishing or prompt injection from
 * everywhere the agent could come across it again. That's the conversation
 * history, the workspace, and the search index.
 *
 * Reached through the control API (`purge` action), which the agent calls with
 * the `purge_content` tool (harness/tools/purge-mcp.mjs).
 *
 * - A message is tombstoned in Postgres. Its text is replaced, not kept
 *   anywhere, and the message keeps its place in the thread. Its mirror file
 *   and index entries are removed.
 * - A workspace file is deleted and its index entries are removed.
 * - Every purge is audited (the `purges` table, which never holds content) and
 *   announced to the team in one email. A wrong purge must never go unnoticed.
 *   The original still exists at its source (Gmail, Slack, Telegram).
 *
 * Guest runs may purge only the message they're handling. The run's trust tier
 * and current message are injected into the tool by the harness, not chosen by
 * the agent. That's the same trust model as `reply`: guest runs have no
 * built-in tools, so the tool is their only way to reach this API.
 */

import { createHash } from "crypto";
import { stat, readFile, rm } from "fs/promises";
import { resolve } from "path";
import { teamRoster } from "@ignis/harness";
import { conversationTitle, channelOf, resolvePurgeTarget } from "./rag-files";
import { senderLabel } from "./conversation-history";
import { getConversation, recordPurge, tombstoneMessage, type PurgeReason } from "./db";
import { agentWorkspace, removeMirroredMessage } from "./conversation-mirror";
import { removeFromIndex } from "./workspace-index";
import { sendEmail, isEmailConfigured } from "./email";
import { getAgent } from "./harness";

export const PURGE_REASONS: PurgeReason[] = ["phishing", "prompt-injection", "other"];

export interface PurgeRequest {
  agentId: string;
  /** The run's trust tier, injected by the harness. */
  trustTier: string;
  /** The inbound message the run is handling, injected by the harness. */
  currentMessage?: { conversationId: string; seq: number };
  /** Purge the message being handled. */
  current?: boolean;
  /** A workspace path: a message mirror under `conversations/`, or any other file. */
  path?: string;
  reason: PurgeReason;
  /** The agent's one-line explanation for the team. Never the content itself. */
  note?: string;
  traceId?: string;
}

export type PurgeResult = { success: true; purged: string; alreadyGone?: boolean } | { success: false; error: string };

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

export async function purgeContent(req: PurgeRequest): Promise<PurgeResult> {
  if (!PURGE_REASONS.includes(req.reason)) {
    return { success: false, error: `reason must be one of: ${PURGE_REASONS.join(", ")}` };
  }
  const workspace = agentWorkspace(req.agentId);
  const target = resolvePurgeTarget(req, workspace);
  if ("error" in target) return { success: false, error: target.error };

  return target.kind === "message" ? purgeMessage(req, target) : purgeFile(req, workspace, target.rel);
}

async function purgeMessage(
  req: PurgeRequest,
  { conversationId, seq }: { conversationId: string; seq: number }
): Promise<PurgeResult> {
  const conv = await getConversation(conversationId);
  if (!conv || conv.agent_id !== req.agentId) return { success: false, error: `No conversation ${conversationId}.` };

  const result = await tombstoneMessage(conversationId, seq, {
    at: new Date().toISOString(),
    reason: req.reason,
    by: "agent",
  });
  if (result.status === "not-found") return { success: false, error: `Conversation ${conversationId} has no message ${seq}.` };

  // Clean up downstream even when already purged: a crash between the
  // tombstone and here would otherwise leave the file and index entry behind.
  const rel = await removeMirroredMessage(req.agentId, conv, seq);
  await removeFromIndex(req.agentId, rel);
  if (result.status === "already-purged") return { success: true, purged: rel, alreadyGone: true };

  await recordPurge({
    agentId: req.agentId,
    kind: "message",
    conversationId,
    seq,
    path: rel,
    reason: req.reason,
    note: req.note,
    contentSha256: sha256(result.original.content),
    trustTier: req.trustTier,
    traceId: req.traceId,
  });

  const channel = channelOf(conv.external_id);
  await notifyTeam(req, [
    `Conversation: "${conversationTitle(result.conversation)}" (${channel})`,
    `Message #${seq} from [${senderLabel(result.original)}], received ${result.original.timestamp}`,
  ], channel === "portal" ? null : channel);
  return { success: true, purged: rel };
}

async function purgeFile(req: PurgeRequest, workspace: string, rel: string): Promise<PurgeResult> {
  const abs = resolve(workspace, rel);
  let content: Buffer | null = null;
  try {
    if ((await stat(abs)).isDirectory()) return { success: false, error: `${rel} is a directory; purge one file at a time.` };
    content = await readFile(abs);
  } catch {
    // Already gone. Still make sure the index forgets it.
  }
  await rm(abs, { force: true });
  await removeFromIndex(req.agentId, rel);
  if (!content) return { success: true, purged: rel, alreadyGone: true };

  await recordPurge({
    agentId: req.agentId,
    kind: "file",
    path: rel,
    reason: req.reason,
    note: req.note,
    contentSha256: sha256(content),
    trustTier: req.trustTier,
    traceId: req.traceId,
  });
  await notifyTeam(req, [`File: ${rel}`], null);
  return { success: true, purged: rel };
}

/** One email to the team per purge. Best-effort: the purge itself already happened. */
async function notifyTeam(req: PurgeRequest, where: string[], source: string | null): Promise<void> {
  const recipients = teamRoster().flatMap((m) => m.emails.slice(0, 1));
  const agentName = (await getAgent(req.agentId))?.name ?? req.agentId;
  const reason = req.reason === "other" ? "unsafe content" : req.reason;
  const subject = `${agentName} removed suspected ${reason}`;
  const body = [
    `${agentName} judged something to be suspected ${reason} and removed it from its history, workspace and search.`,
    "",
    ...where,
    ...(req.note ? [`Why: ${req.note}`] : []),
    "",
    source
      ? `If this was a mistake, the original is still in ${source}; ${agentName} just can't see it anymore.`
      : `The text is gone for good.`,
  ].join("\n");

  if (recipients.length === 0 || !isEmailConfigured()) {
    console.warn(`[Purge] ${subject} — team not notified (no roster emails or email not configured)\n${body}`);
    return;
  }
  try {
    const [to, ...cc] = recipients;
    await sendEmail(to, subject, body, cc.length ? { cc: cc.join(",") } : undefined);
  } catch (err) {
    console.error(`[Purge] failed to notify the team:`, err);
  }
}
