/**
 * Postgres Database Layer
 *
 * Stores conversations with their messages as JSONB.
 * Claude Code manages actual session state — we just store the session_id
 * for resumption and a copy of messages for UI display.
 */

import pg from "pg";
import { v4 as uuid } from "uuid";
import type { ThreadContext } from "./thread-context";

const { Pool } = pg;

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /**
   * Verified sender of this message at the time of receipt. Set on `user`
   * rows by the messaging layer from the channel's identity resolver. The
   * userId is a team-roster id; history keeps whatever id was current when the
   * row was written, so a later rename renders as the raw id rather than
   * rewriting the past.
   * Omitted on `assistant` rows and on user rows persisted before the
   * identity layer existed (rendered as `[User]` in history).
   */
  sender?:
    | { kind: "authenticated"; userId: string }
    | { kind: "guest" };
  /**
   * Set when the message was purged as suspected phishing or prompt injection.
   * `content` is then empty — the original text is kept nowhere — and the
   * message keeps its place in the array so every later message's position
   * (and so its mirror file, `<seq>.md`) stays put. See lib/purge.ts.
   */
  purged?: MessagePurge;
}

export type PurgeReason = "phishing" | "prompt-injection" | "other";

export interface MessagePurge {
  at: string;
  reason: PurgeReason;
  /** `agent` when the agent purged it through `purge_content`. */
  by: string;
}

export interface Conversation {
  id: string;
  profile: string | null;
  session_id: string | null;
  title: string | null;
  external_id: string | null;
  messages: Message[];
  /**
   * Facts about the task run that created this thread (set on outbound-initiated
   * threads). Replayed to the agent when a reply is handled. Null for
   * inbound-initiated or ad-hoc threads.
   */
  thread_context: ThreadContext | null;
  /**
   * RFC 5322 `Message-ID`s (normalized, bracket-stripped) the agent has seen or
   * sent in this thread. Used by the email channel to tell a direct reply apart
   * from a reply whose parent arrived off our inbox (a side conversation), so
   * quoted history is surfaced only when it carries something new. Empty for
   * non-email threads and for threads predating this tracking.
   */
  seen_channel_ids: string[];
  created_at: string;
  updated_at: string;
}

// --- Pool ---

let pool: pg.Pool | null = null;

/**
 * The shared Postgres pool. Exported so sibling modules (e.g. the job-run
 * ledger) run against the same connection pool and the same ensured schema
 * rather than opening their own.
 */
export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.POSTGRES_URL;
    if (!connectionString) {
      throw new Error("POSTGRES_URL environment variable is not set");
    }
    pool = new Pool({ connectionString });
  }
  return pool;
}

// --- Schema ---

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id TEXT,
  title TEXT,
  external_id TEXT,
  messages JSONB DEFAULT '[]'::jsonb,
  thread_context JSONB,
  seen_channel_ids TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'external_id'
  ) THEN
    ALTER TABLE conversations ADD COLUMN external_id TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'profile'
  ) THEN
    ALTER TABLE conversations ADD COLUMN profile TEXT;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'thread_context'
  ) THEN
    ALTER TABLE conversations ADD COLUMN thread_context JSONB;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'seen_channel_ids'
  ) THEN
    ALTER TABLE conversations ADD COLUMN seen_channel_ids TEXT[] NOT NULL DEFAULT '{}';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_updated
  ON conversations(updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_external
  ON conversations(external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) NOT NULL UNIQUE,
  value JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS telegram_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  tg_message_id TEXT NOT NULL,
  content TEXT NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (chat_id, tg_message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_messages_chat
  ON telegram_messages(chat_id, timestamp DESC);

-- Durable per-execution ledger for every agent job (inbound message, scheduled,
-- triggered, or portal run). A row is written BEFORE the run launches, carrying
-- the full replay envelope, so a job can be re-run from the portal even if the
-- process that started it dies mid-run. See lib/job-ledger.ts.
CREATE TABLE IF NOT EXISTS job_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- If this run is a replay of an earlier one, the id of that run. SET NULL on
  -- delete so eviction of the original doesn't cascade away the replay history.
  replay_of UUID REFERENCES job_runs(id) ON DELETE SET NULL,
  -- 'inbound' | 'scheduler' | 'trigger' | 'portal'
  source TEXT NOT NULL,
  profile TEXT,
  -- Human-readable one-liner for the Runs list (job description, message preview).
  label TEXT,
  -- 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
  status TEXT NOT NULL DEFAULT 'pending',
  -- Only set when status='failed': 'api' | 'agent' | 'orchestration' | 'orphaned' | 'dropped'
  failure_class TEXT,
  error TEXT,
  -- Everything needed to re-run this exact job (shape depends on source).
  envelope JSONB NOT NULL,
  -- Orchestrator trace id, so the /api/traces hook stream can renew the lease.
  trace_id TEXT,
  session_id TEXT,
  -- Total tokens (input + output + cache) for the run, from the agent result
  -- usage. Null for runs with no usage (e.g. notify jobs) or that predate this.
  tokens BIGINT,
  -- A run past this instant with a non-terminal status is treated as orphaned
  -- (crashed/hung) and reaped to failed. Renewed by hook activity.
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'job_runs' AND column_name = 'tokens'
  ) THEN
    ALTER TABLE job_runs ADD COLUMN tokens BIGINT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_job_runs_status ON job_runs(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_runs_trace ON job_runs(trace_id) WHERE trace_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_job_runs_created ON job_runs(created_at DESC);

-- Audit trail for purge_content. Deliberately never holds the purged text —
-- only where it was, why, and a hash to recognize it by. See lib/purge.ts.
CREATE TABLE IF NOT EXISTS purges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 'message' | 'file'
  kind TEXT NOT NULL,
  conversation_id UUID,
  seq INTEGER,
  -- Workspace-relative path: the mirror file for a message, the file itself otherwise.
  path TEXT NOT NULL,
  reason TEXT NOT NULL,
  note TEXT,
  content_sha256 TEXT,
  trust_tier TEXT NOT NULL,
  trace_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purges_created ON purges(created_at DESC);

-- The team roster: who this install serves. Being on it is what grants the
-- team trust tier. See lib/team.ts, the only writer.
CREATE TABLE IF NOT EXISTS team_members (
  -- Stable id, referenced by conversation history, the portal cookie and the
  -- agent's config/team/<id>.md. Never changes after the row is created.
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name TEXT NOT NULL CHECK (btrim(name) <> ''),
  -- Lowercased; the first is the primary. Unique across members, enforced in
  -- lib/team.ts since an index can't reach inside an array.
  emails TEXT[] NOT NULL DEFAULT '{}',
  slack_id TEXT UNIQUE,
  telegram_id TEXT UNIQUE,
  is_owner BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_owner ON team_members(is_owner) WHERE is_owner;
`;

let schemaEnsured = false;

export async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await getPool().query(SCHEMA_SQL);
  schemaEnsured = true;
}

// --- Queries ---

export async function createConversation(
  title: string,
  externalId?: string,
  profile?: string,
  threadContext?: ThreadContext
): Promise<Conversation> {
  await ensureSchema();
  const id = uuid();

  // If external_id collides (race between concurrent inbound messages on the
  // same thread), return the existing row instead of throwing.
  const result = await getPool().query(
    `INSERT INTO conversations (id, profile, title, external_id, messages, thread_context)
     VALUES ($1, $2, $3, $4, '[]'::jsonb, $5)
     ON CONFLICT (external_id) WHERE external_id IS NOT NULL DO UPDATE
       SET updated_at = conversations.updated_at
     RETURNING *`,
    [id, profile ?? null, title, externalId ?? null, threadContext ? JSON.stringify(threadContext) : null]
  );
  return rowToConversation(result.rows[0]);
}

export async function getConversation(id: string): Promise<Conversation | null> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT * FROM conversations WHERE id = $1`,
    [id]
  );
  if (result.rows.length === 0) return null;
  return rowToConversation(result.rows[0]);
}

export async function getConversationByExternalId(
  externalId: string
): Promise<Conversation | null> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT * FROM conversations WHERE external_id = $1`,
    [externalId]
  );
  if (result.rows.length === 0) return null;
  return rowToConversation(result.rows[0]);
}

export async function listConversations(limit = 20): Promise<Conversation[]> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows.map(rowToConversation);
}

/**
 * Append messages to a conversation. Returns the array position (`seq`) of the
 * first appended message, or null if the conversation doesn't exist.
 *
 * Each appended message is then mirrored to its own file in the agent's
 * workspace for search (lib/conversation-mirror.ts). That happens after the
 * write commits and never fails or delays the caller.
 */
export async function appendMessages(
  conversationId: string,
  newMessages: Message[]
): Promise<number | null> {
  await ensureSchema();
  // Append to the JSONB array and update timestamp
  const result = await getPool().query(
    `UPDATE conversations
     SET messages = messages || $1::jsonb,
         updated_at = now()
     WHERE id = $2
     RETURNING jsonb_array_length(messages) AS len`,
    [JSON.stringify(newMessages), conversationId]
  );
  if (result.rows.length === 0) return null;
  const startSeq = Number(result.rows[0].len) - newMessages.length;

  // Imported lazily: the mirror reads conversations back through this module.
  import("./conversation-mirror")
    .then((m) => m.mirrorAppended(conversationId, startSeq, newMessages.length))
    .catch((err) => console.error(`[DB] Conversation mirror failed for ${conversationId}:`, err));

  return startSeq;
}

/** Every conversation, oldest first (mirror backfill). */
export async function listAllConversations(): Promise<Conversation[]> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT * FROM conversations ORDER BY created_at ASC`
  );
  return result.rows.map(rowToConversation);
}

export type TombstoneResult =
  | { status: "purged"; original: Message; conversation: Conversation }
  | { status: "already-purged"; conversation: Conversation }
  | { status: "not-found" };

/**
 * Replace one message's content with a tombstone, in place. The original text
 * is returned to the caller (for hashing) and exists nowhere afterwards.
 * Row-locked, so a concurrent append can't shift the position underneath it.
 */
export async function tombstoneMessage(
  conversationId: string,
  seq: number,
  purge: MessagePurge
): Promise<TombstoneResult> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query(`SELECT * FROM conversations WHERE id = $1 FOR UPDATE`, [
      conversationId,
    ]);
    if (found.rows.length === 0) {
      await client.query("ROLLBACK");
      return { status: "not-found" };
    }
    const conversation = rowToConversation(found.rows[0]);
    const original = conversation.messages[seq];
    if (!original) {
      await client.query("ROLLBACK");
      return { status: "not-found" };
    }
    if (original.purged) {
      await client.query("ROLLBACK");
      return { status: "already-purged", conversation };
    }
    const tombstone: Message = { ...original, content: "", purged: purge };
    await client.query(
      `UPDATE conversations SET messages = jsonb_set(messages, $1::text[], $2::jsonb) WHERE id = $3`,
      [[String(seq)], JSON.stringify(tombstone), conversationId]
    );
    await client.query("COMMIT");
    conversation.messages[seq] = tombstone;
    return { status: "purged", original, conversation };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export interface PurgeRecord {
  kind: "message" | "file";
  conversationId?: string;
  seq?: number;
  path: string;
  reason: PurgeReason;
  note?: string;
  contentSha256?: string;
  trustTier: string;
  traceId?: string;
}

export async function recordPurge(r: PurgeRecord): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO purges (kind, conversation_id, seq, path, reason, note, content_sha256, trust_tier, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      r.kind,
      r.conversationId ?? null,
      r.seq ?? null,
      r.path,
      r.reason,
      r.note ?? null,
      r.contentSha256 ?? null,
      r.trustTier,
      r.traceId ?? null,
    ]
  );
}

/**
 * Union `ids` into a conversation's `seen_channel_ids` (deduplicated). Blank ids
 * are dropped and a no-op call short-circuits. Idempotent: re-adding a known id
 * changes nothing. Used by the email channel to record the RFC `Message-ID`s of
 * inbound messages and the agent's own replies.
 */
export async function addSeenChannelIds(
  conversationId: string,
  ids: string[]
): Promise<void> {
  const clean = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (clean.length === 0) return;
  await ensureSchema();
  await getPool().query(
    `UPDATE conversations
     SET seen_channel_ids = ARRAY(
           SELECT DISTINCT unnest(COALESCE(seen_channel_ids, '{}') || $1::text[])
         ),
         updated_at = now()
     WHERE id = $2`,
    [clean, conversationId]
  );
}

/**
 * Append an assistant turn to the conversation identified by `externalId`, at
 * the moment a reply is actually delivered. Returns the conversation id (so
 * callers can do channel-specific follow-up like recording seen message-ids), or
 * null if no conversation exists for that key. This is the "history-from-sends"
 * write path shared by every external channel: replayed history stays a faithful
 * copy of what was really sent into the thread.
 */
export async function appendAssistantReply(
  externalId: string,
  content: string
): Promise<string | null> {
  const conversation = await getConversationByExternalId(externalId);
  if (!conversation) return null;
  await appendMessages(conversation.id, [
    { role: "assistant", content, timestamp: new Date().toISOString() },
  ]);
  return conversation.id;
}

export async function updateSessionId(
  conversationId: string,
  sessionId: string
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `UPDATE conversations SET session_id = $1, updated_at = now() WHERE id = $2`,
    [sessionId, conversationId]
  );
}

// --- Settings ---

export async function getSetting<T = unknown>(key: string): Promise<T | null> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT value FROM app_settings WHERE key = $1`,
    [key]
  );
  if (result.rows.length === 0) return null;
  return result.rows[0].value as T;
}

export async function setSetting<T = unknown>(key: string, value: T): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO app_settings (id, key, value)
     VALUES (gen_random_uuid(), $1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, JSON.stringify(value)]
  );
}

export async function deleteSetting(key: string): Promise<boolean> {
  await ensureSchema();
  const result = await getPool().query(
    `DELETE FROM app_settings WHERE key = $1`,
    [key]
  );
  return (result.rowCount ?? 0) > 0;
}

// --- Telegram Messages ---

export interface TelegramMessageRecord {
  id: string;
  chat_id: string;
  sender_id: string;
  sender_name: string | null;
  tg_message_id: string;
  content: string;
  timestamp: string;
}

export async function storeTelegramMessage(
  chatId: string,
  senderId: string,
  senderName: string | null,
  tgMessageId: string,
  content: string,
  timestamp: Date
): Promise<void> {
  await ensureSchema();
  await getPool().query(
    `INSERT INTO telegram_messages (chat_id, sender_id, sender_name, tg_message_id, content, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chat_id, tg_message_id) DO NOTHING`,
    [chatId, senderId, senderName, tgMessageId, content, timestamp]
  );
}

export async function getRecentTelegramMessages(
  chatId: string,
  limit = 20
): Promise<TelegramMessageRecord[]> {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT * FROM telegram_messages
     WHERE chat_id = $1
     ORDER BY timestamp DESC
     LIMIT $2`,
    [chatId, limit]
  );
  // Reverse so oldest is first (chronological order)
  return result.rows.map(rowToTelegramMessage).reverse();
}

// --- Helpers ---

function rowToTelegramMessage(row: Record<string, unknown>): TelegramMessageRecord {
  return {
    id: row.id as string,
    chat_id: row.chat_id as string,
    sender_id: row.sender_id as string,
    sender_name: (row.sender_name as string | null) ?? null,
    tg_message_id: row.tg_message_id as string,
    content: row.content as string,
    timestamp: (row.timestamp as Date).toISOString(),
  };
}

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    profile: (row.profile as string | null) ?? null,
    session_id: row.session_id as string | null,
    title: row.title as string | null,
    external_id: (row.external_id as string | null) ?? null,
    messages: (typeof row.messages === "string"
      ? JSON.parse(row.messages)
      : row.messages) as Message[],
    thread_context: (row.thread_context == null
      ? null
      : typeof row.thread_context === "string"
        ? JSON.parse(row.thread_context)
        : row.thread_context) as ThreadContext | null,
    seen_channel_ids: (row.seen_channel_ids as string[] | null) ?? [],
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}
