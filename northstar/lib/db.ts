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
  workflow_id: string;
  session_id: string | null;
  title: string | null;
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
  workflow_id TEXT NOT NULL,
  session_id TEXT,
  title TEXT,
  messages JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_workflow
  ON conversations(workflow_id, updated_at DESC);
`;

let schemaEnsured = false;

export async function ensureSchema(): Promise<void> {
  if (schemaEnsured) return;
  await getPool().query(SCHEMA_SQL);
  schemaEnsured = true;
}

// --- Queries ---

export async function createConversation(
  workflowId: string,
  title: string
): Promise<Conversation> {
  await ensureSchema();
  const id = uuid();
  const result = await getPool().query(
    `INSERT INTO conversations (id, workflow_id, title, messages)
     VALUES ($1, $2, $3, '[]'::jsonb)
     RETURNING *`,
    [id, workflowId, title]
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

export async function listConversations(
  workflowId?: string,
  limit = 20
): Promise<Conversation[]> {
  await ensureSchema();
  let query: string;
  let params: (string | number)[];

  if (workflowId) {
    query = `SELECT * FROM conversations WHERE workflow_id = $1
             ORDER BY updated_at DESC LIMIT $2`;
    params = [workflowId, limit];
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

// --- Helpers ---

function rowToConversation(row: Record<string, unknown>): Conversation {
  return {
    id: row.id as string,
    workflow_id: row.workflow_id as string,
    session_id: row.session_id as string | null,
    title: row.title as string | null,
    messages: (typeof row.messages === "string"
      ? JSON.parse(row.messages)
      : row.messages) as Message[],
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}
