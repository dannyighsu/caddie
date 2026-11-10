/**
 * Workspace RAG: file layout and indexing rules (pure logic).
 *
 * Shared by the conversation mirror (lib/conversation-mirror.ts), which writes
 * one markdown file per message into the agent's workspace, and the indexer
 * (lib/workspace-index.ts), which keeps a local mcp-local-rag index in sync
 * with the workspace. The agent searches that index through the `local-rag`
 * capability and opens the files it points at.
 */

import { isAbsolute, normalize, relative, resolve } from "path";
import type { Conversation, Message } from "./db";

/** Where message mirrors live, relative to the workspace. */
export const CONVERSATIONS_DIR = "conversations";

/**
 * Index state: the LanceDB database, the embedding-model cache and the sync
 * manifest. A dot-directory, so it is never itself indexed.
 */
export const RAG_DIR = ".rag";

/**
 * The embedding model. Pinned here and in harness/capabilities/local-rag.json
 * rather than left to mcp-local-rag's default, so a server upgrade can't
 * silently change the embedding space under an existing index.
 */
export const RAG_MODEL_NAME = "Xenova/all-MiniLM-L6-v2";

/** Files mcp-local-rag can ingest. Anything else is skipped, not failed. */
export const INDEXED_EXTENSIONS = new Set([".md", ".txt", ".pdf", ".docx", ".html", ".htm"]);

export const MAX_INDEXED_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Top-level workspace directories that are never indexed:
 * - `mounts/`: repo checkouts (repo-mount skill); code, not memory.
 * - `jobs/`, `tickets/`: job procedures and the agent's own bug reports;
 *   operating material, not memory.
 */
const EXCLUDED_TOP_LEVEL = new Set(["mounts", "jobs", "tickets"]);

export type ConversationChannel = "email" | "slack" | "telegram" | "linear" | "portal" | "other";

/**
 * The channel a conversation came in on, from its `external_id` namespace
 * (`email:<thread>`, `slack:<channel>:<ts>`, `telegram:<chat>`, `linear:<session>`). Portal chats
 * have no external id.
 */
export function channelOf(externalId: string | null): ConversationChannel {
  if (!externalId) return "portal";
  const prefix = externalId.split(":", 1)[0];
  return prefix === "email" || prefix === "slack" || prefix === "telegram" || prefix === "linear" ? prefix : "other";
}

/**
 * Workspace-relative path of one message's mirror file:
 * `conversations/<channel>/<conversation-id>/<seq>.md`, where `seq` is the
 * message's position in the conversation (stable: messages are only appended,
 * and a purge tombstones in place).
 */
export function messageRelPath(conv: Pick<Conversation, "id" | "external_id">, seq: number): string {
  return `${CONVERSATIONS_DIR}/${channelOf(conv.external_id)}/${conv.id}/${String(seq).padStart(4, "0")}.md`;
}

/** Inverse of {@link messageRelPath}; null for any other path. */
export function parseMessageRelPath(relPath: string): { conversationId: string; seq: number } | null {
  const m = relPath.match(/^conversations\/[a-z]+\/([0-9a-f-]{36})\/(\d+)\.md$/i);
  return m ? { conversationId: m[1], seq: Number(m[2]) } : null;
}

/** One-line thread title for the file's heading. */
export function conversationTitle(conv: Pick<Conversation, "title" | "messages">): string {
  const raw = conv.title?.trim() || conv.messages.find((m) => m.role === "user")?.content || "Untitled conversation";
  const line = raw.split("\n").find((l) => l.trim()) ?? raw;
  const clean = line.replace(/\s+/g, " ").trim();
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}

function utcMinute(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Render one message as a standalone markdown document. Each carries its
 * thread's title (search hits display it) and enough frontmatter to find the
 * neighbouring messages. `sender` is the label the agent sees in its prompt
 * history (`senderLabel()`), so the two read the same.
 */
export function renderMessageFile(
  conv: Pick<Conversation, "id" | "external_id" | "title" | "messages">,
  seq: number,
  msg: Message,
  sender: string
): string {
  const title = conversationTitle(conv);
  const frontmatter = [
    "---",
    `title: ${JSON.stringify(title)}`,
    `conversation_id: ${conv.id}`,
    `seq: ${seq}`,
    `channel: ${channelOf(conv.external_id)}`,
    ...(conv.external_id ? [`external_id: ${JSON.stringify(conv.external_id)}`] : []),
    `sender: ${JSON.stringify(sender)}`,
    `timestamp: ${msg.timestamp}`,
    "---",
  ];
  return `${frontmatter.join("\n")}\n\n# ${title}\n\n**[${sender}] ${utcMinute(msg.timestamp)}**\n\n${msg.content}\n`;
}

/**
 * Whether a directory (workspace-relative, no trailing slash) is walked at all.
 * Dot-directories are harness and tool internals (`.claude/`, `.rag/`,
 * `.playwright-mcp/`); run artifacts are DOM snapshots, scratch and email
 * attachments, all out of scope.
 */
export function isExcludedDir(relDir: string): boolean {
  const parts = relDir.split("/");
  if (EXCLUDED_TOP_LEVEL.has(parts[0])) return true;
  if (parts.some((p) => p.startsWith(".") || p === "node_modules")) return true;
  // runs/<month>/<day>/artifacts
  return parts[0] === "runs" && parts.includes("artifacts");
}

/** Whether a file (workspace-relative) belongs in the index. */
export function isIndexableFile(relPath: string, size: number): boolean {
  const slash = relPath.lastIndexOf("/");
  const base = relPath.slice(slash + 1);
  if (slash > 0 && isExcludedDir(relPath.slice(0, slash))) return false;
  if (slash < 0 && EXCLUDED_TOP_LEVEL.has(base)) return false;
  if (base.startsWith(".")) return false;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || !INDEXED_EXTENSIONS.has(base.slice(dot).toLowerCase())) return false;
  return size <= MAX_INDEXED_FILE_SIZE;
}

export interface FileFingerprint {
  sha256: string;
  size: number;
}

/** Sync state, stored at `<workspace>/.rag/manifest.json`. */
export interface RagManifest {
  /** Workspace-relative path → what was last ingested successfully. */
  files: Record<string, FileFingerprint>;
  /** Paths that failed to ingest; retried every sync until they succeed or vanish. */
  failures: string[];
  last_sync: string | null;
  /** Embedding model the index was built with. */
  model: string;
  /** Absolute workspace path the index was built at (the DB stores absolute paths). */
  workspace: string;
}

export function emptyManifest(workspace: string): RagManifest {
  return { files: {}, failures: [], last_sync: null, model: RAG_MODEL_NAME, workspace };
}

/**
 * Why a manifest can't be synced incrementally, or null if it can. Mixing
 * embedding models degrades search silently; a moved workspace leaves the DB
 * pointing at dead paths.
 */
export function rebuildReason(manifest: RagManifest, workspace: string): string | null {
  if (manifest.model !== RAG_MODEL_NAME) {
    return `index was built with ${manifest.model}, configured model is ${RAG_MODEL_NAME}`;
  }
  if (manifest.workspace !== workspace) {
    return `index was built at ${manifest.workspace}, workspace is now ${workspace}`;
  }
  return null;
}

/**
 * What a sync must do: ingest every new, changed or previously failed file, and
 * delete every indexed file that's gone or no longer eligible. A file whose
 * content is unchanged is left alone, whatever its mtime.
 */
export function planSync(
  manifest: Pick<RagManifest, "files" | "failures">,
  onDisk: Map<string, FileFingerprint>
): { ingest: string[]; remove: string[] } {
  const failed = new Set(manifest.failures);
  const ingest: string[] = [];
  for (const [path, fp] of onDisk) {
    const known = manifest.files[path];
    if (!known || known.sha256 !== fp.sha256 || failed.has(path)) ingest.push(path);
  }
  const remove = Object.keys(manifest.files).filter((path) => !onDisk.has(path));
  return { ingest: ingest.sort(), remove: remove.sort() };
}

// --- Purge targets (lib/purge.ts) ---

/** Workspace areas a purge may never touch. */
const PROTECTED_PREFIXES = ["mounts/", "jobs/", "tickets/", ".rag/", ".claude/", "config/"];

export interface PurgeTargetRequest {
  /** The run's trust tier, injected by the harness. */
  trustTier: string;
  /** The inbound message the run is handling, injected by the harness. */
  currentMessage?: { conversationId: string; seq: number };
  current?: boolean;
  path?: string;
}

export type Target =
  | { kind: "message"; conversationId: string; seq: number }
  | { kind: "file"; rel: string };

/** Resolve an agent-supplied path to a workspace-relative one, refusing escapes. */
export function workspaceRelative(workspace: string, path: string): string | null {
  const abs = isAbsolute(path) ? normalize(path) : resolve(workspace, path);
  const rel = relative(workspace, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split("\\").join("/");
}

export function resolvePurgeTarget(
  req: PurgeTargetRequest,
  workspace: string
): Target | { error: string } {
  if (!!req.current === !!req.path) {
    return { error: "Pass exactly one of `current: true` or `path`." };
  }

  let target: Target;
  if (req.current) {
    if (!req.currentMessage) return { error: "This run isn't handling an inbound message, so there's no current message to purge." };
    target = { kind: "message", ...req.currentMessage };
  } else {
    const rel = workspaceRelative(workspace, req.path!);
    if (!rel) return { error: `${req.path} is outside your workspace.` };
    const msg = parseMessageRelPath(rel);
    if (msg) {
      target = { kind: "message", ...msg };
    } else if (rel.startsWith("conversations/")) {
      return { error: `${rel} isn't a message file (conversations/<channel>/<id>/<seq>.md).` };
    } else if (PROTECTED_PREFIXES.some((p) => rel.startsWith(p))) {
      return { error: `${rel} can't be purged: ${rel.split("/")[0]}/ isn't content that came from outside.` };
    } else {
      target = { kind: "file", rel };
    }
  }

  if (req.trustTier !== "team") {
    const cur = req.currentMessage;
    const isCurrent =
      target.kind === "message" && !!cur && cur.conversationId === target.conversationId && cur.seq === target.seq;
    if (!isCurrent) return { error: "On a guest run you can only purge the message you're handling (`current: true`)." };
  }
  return target;
}

