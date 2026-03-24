/**
 * Postgres Database Layer
 *
 * Stores conversations with their messages as JSONB.
 * Claude Code manages actual session state — we just store the session_id
 * for resumption and a copy of messages for UI display.
 */

import pg from "pg";
import { v4 as uuid } from "uuid";

const { Pool } = pg;

export interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

export interface Conversation {
  id: string;
  agent_id: string;
  session_id: string | null;
  title: string | null;
  external_id: string | null;
  messages: Message[];
  created_at: string;
  updated_at: string;
}

// --- Pool ---

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
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
  agent_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT,
  external_id TEXT,
  messages JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_agent
  ON conversations(agent_id, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_external
  ON conversations(external_id) WHERE external_id IS NOT NULL;

-- Migration: rename workflow_id to agent_id if needed
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'workflow_id'
  ) THEN
    ALTER TABLE conversations RENAME COLUMN workflow_id TO agent_id;
  END IF;
END $$;

-- Migration: add external_id column if missing
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'conversations' AND column_name = 'external_id'
  ) THEN
    ALTER TABLE conversations ADD COLUMN external_id TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS app_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(255) NOT NULL UNIQUE,
  value JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
`;

let schemaEnsured = false;

export async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await getPool().query(SCHEMA_SQL);
  schemaEnsured = true;
}

// --- Queries ---

export async function createConversation(
  agentId: string,
  title: string,
  externalId?: string
): Promise<Conversation> {
  await ensureSchema();
  const id = uuid();
  const result = await getPool().query(
    `INSERT INTO conversations (id, agent_id, title, external_id, messages)
     VALUES ($1, $2, $3, $4, '[]'::jsonb)
     RETURNING *`,
    [id, agentId, title, externalId ?? null]
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

export async function listConversations(
  agentId?: string,
  limit = 20
): Promise<Conversation[]> {
  await ensureSchema();
  let query: string;
  let params: (string | number)[];

  if (agentId) {
    query = `SELECT * FROM conversations WHERE agent_id = $1
             ORDER BY updated_at DESC LIMIT $2`;
    params = [agentId, limit];
  } else {
    query = `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT $1`;
    params = [limit];
  }

  const result = await getPool().query(query, params);
  return result.rows.map(rowToConversation);
}

export async function appendMessages(
  conversationId: string,
  newMessages: Message[]
): Promise<void> {
  await ensureSchema();
  // Append to the JSONB array and update timestamp
  await getPool().query(
    `UPDATE conversations
     SET messages = messages || $1::jsonb,
         updated_at = now()
     WHERE id = $2`,
    [JSON.stringify(newMessages), conversationId]
  );
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

// --- Helpers ---

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    session_id: row.session_id as string | null,
    title: row.title as string | null,
    external_id: (row.external_id as string | null) ?? null,
    messages: (typeof row.messages === "string"
      ? JSON.parse(row.messages)
      : row.messages) as Message[],
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}
