/**
 * Job-Run Ledger
 *
 * A durable, replayable record of every agent job execution — inbound message,
 * scheduled fire, manual trigger, or portal run. This is the backbone of the
 * replay mechanism: because a row is written (status `running`, with the full
 * replay envelope) BEFORE the run launches, a job can be re-run from the portal
 * even if the process that started it dies mid-run.
 *
 * Lifecycle of a row:
 *   beginRun(envelope)  → status 'running', lease set
 *   ...run executes...
 *   finishRun(...)      → 'succeeded' | 'failed' | 'skipped', lease cleared
 *
 * "Fails out" = a row ends in `status='failed'`. That covers five classes,
 * carried in `failure_class`:
 *   - 'api'           API-layer failure (expired OAuth, rate limit, overload)
 *   - 'agent'         the agent ran and returned a task error
 *   - 'orchestration' a throw around the launch (DB, classifier, delivery, ...)
 *   - 'orphaned'      the run never reported completion before its lease expired
 *                     (process crash or hang) — set by the reaper, not the run
 *   - 'dropped'       a one-shot occurrence skipped because another run for the
 *                     same agent was already active, so the occurrence was lost
 *
 * Rows are evicted after a retention window (default 7 days). Replaying a run
 * reconstructs its original call and produces a NEW row linked by `replay_of`.
 */

import { v4 as uuid } from "uuid";
import { getPool, ensureSchema } from "./db";
import { classifyRunFailure } from "./failure-classifier";
import type { ScheduledJob } from "./redis";
import type { InboundMessageParams, ReplyTarget } from "./messaging";
import type { PortalRunInput } from "./portal-run";

/** How long a run may go without reporting completion before it's reaped. */
const DEFAULT_LEASE_MS = 30 * 60 * 1000; // 30 minutes
/** Rows older than this are evicted. */
export const DEFAULT_RETENTION_DAYS = 7;

export type RunSource = "inbound" | "scheduler" | "trigger" | "portal";
export type RunStatus = "running" | "succeeded" | "failed" | "skipped";
export type FailureClass =
  | "api"
  | "agent"
  | "orchestration"
  | "orphaned"
  | "dropped";

/**
 * Everything needed to re-run a job, discriminated by source. Must stay JSON-
 * serializable — the inbound variant deliberately omits the non-serializable
 * `replyFn` closure, which is reconstructed from `replyTarget` at replay time.
 */
export type SerializableInboundParams = Omit<InboundMessageParams, "replyFn">;

export type RunEnvelope =
  | { source: "scheduler" | "trigger"; job: ScheduledJob }
  | { source: "inbound"; params: SerializableInboundParams }
  | { source: "portal"; input: PortalRunInput };

export interface JobRun {
  id: string;
  replay_of: string | null;
  source: RunSource;
  profile: string | null;
  label: string | null;
  status: RunStatus;
  failure_class: FailureClass | null;
  error: string | null;
  envelope: RunEnvelope;
  trace_id: string | null;
  session_id: string | null;
  /** Total tokens (input + output + cache) for the run, or null if unknown. */
  tokens: number | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Sum the token counts from an agent result's `usage` blob into a single total
 * (input + output + cache read/creation). Robust to missing fields and to the
 * shape varying: any numeric property whose name ends in `_tokens` is counted.
 * Returns null when there's no usable usage, so we store NULL rather than 0.
 */
export function sumUsageTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  let total = 0;
  let found = false;
  for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
    if (key.endsWith("_tokens") && typeof value === "number" && Number.isFinite(value)) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

// --- Write path ---

export interface BeginRunOpts {
  profile?: string | null;
  /** One-liner shown in the Runs list. */
  label?: string;
  /** Orchestrator trace id, so hook activity can renew this run's lease. */
  traceId?: string;
  /** Set when this run is a replay of an earlier one. */
  replayOf?: string;
  leaseMs?: number;
}

/**
 * Open a ledger row for a run about to launch. Returns the run id, which the
 * caller threads into finishRun. Writes status 'running' with a lease — if the
 * process dies before finishRun, the reaper flips the row to failed/orphaned.
 */
export async function beginRun(
  envelope: RunEnvelope,
  opts: BeginRunOpts
): Promise<string> {
  await ensureSchema();
  const id = uuid();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  await getPool().query(
    `INSERT INTO job_runs
       (id, replay_of, source, profile, label, status, envelope, trace_id, lease_expires_at)
     VALUES ($1, $2, $3, $4, $5, 'running', $6, $7, now() + ($8 || ' milliseconds')::interval)`,
    [
      id,
      opts.replayOf ?? null,
      envelope.source,
      opts.profile ?? null,
      opts.label ?? null,
      JSON.stringify(envelope),
      opts.traceId ?? null,
      leaseMs,
    ]
  );
  return id;
}

/** Set a run's terminal state and clear its lease. Idempotent (last write wins). */
export async function finishRun(
  id: string,
  fields: {
    status: RunStatus;
    failureClass?: FailureClass;
    error?: string;
    sessionId?: string;
    /** Total tokens for the run; only overwrites the stored value when provided. */
    tokens?: number | null;
  }
): Promise<void> {
  await getPool().query(
    `UPDATE job_runs
       SET status = $2,
           failure_class = $3,
           error = $4,
           session_id = COALESCE($5, session_id),
           tokens = COALESCE($6, tokens),
           lease_expires_at = NULL,
           updated_at = now()
     WHERE id = $1`,
    [
      id,
      fields.status,
      fields.failureClass ?? null,
      fields.error ? fields.error.substring(0, 4000) : null,
      fields.sessionId ?? null,
      fields.tokens ?? null,
    ]
  );
}

/**
 * Finish from an agent launch result, classifying an API-layer failure apart
 * from an ordinary agent-task error. Records token usage when the result carries
 * it (a failed run may still have spent tokens before erroring).
 */
export async function finishFromResult(
  id: string,
  result: { success: boolean; error?: string; sessionId?: string; usage?: unknown }
): Promise<void> {
  const tokens = sumUsageTokens(result.usage);
  if (result.success) {
    await finishRun(id, { status: "succeeded", sessionId: result.sessionId, tokens });
    return;
  }
  const classified = await classifyRunFailure(result);
  await finishRun(id, {
    status: "failed",
    failureClass: classified?.failureClass ?? "agent",
    error: classified?.detail ?? result.error ?? "Unknown error",
    sessionId: result.sessionId,
    tokens,
  });
}

/** Finish a run that threw around the launch (DB, classifier, delivery, ...). */
export async function failOrchestration(id: string, error: string): Promise<void> {
  await finishRun(id, { status: "failed", failureClass: "orchestration", error });
}

/**
 * Finish a run that never launched because another run for the same agent was
 * already active. A one-shot occurrence is lost when this happens, so it's
 * recorded as a failure ('dropped') and offered for replay; a recurring
 * occurrence just fires again next tick, so it's a benign 'skipped'.
 */
export async function finishSkipped(id: string, dropped: boolean): Promise<void> {
  if (dropped) {
    await finishRun(id, {
      status: "failed",
      failureClass: "dropped",
      error:
        "One-shot occurrence dropped: another run for this agent was already active.",
    });
  } else {
    await finishRun(id, { status: "skipped" });
  }
}

/**
 * Extend the lease on any running rows for a trace. Called best-effort from the
 * hook stream (/api/traces) so a long-but-alive run isn't reaped as orphaned.
 */
export async function renewLeaseByTrace(
  traceId: string,
  leaseMs = DEFAULT_LEASE_MS
): Promise<void> {
  await getPool().query(
    `UPDATE job_runs
       SET lease_expires_at = now() + ($2 || ' milliseconds')::interval,
           updated_at = now()
     WHERE trace_id = $1 AND status = 'running'`,
    [traceId, leaseMs]
  );
}

// --- Maintenance ---

/**
 * Flip any run stuck 'running' past its lease to failed/orphaned. This is the
 * only detector for crashes and hangs — the process that would otherwise call
 * finishRun is gone. Returns the number reaped.
 */
export async function reapOrphans(): Promise<number> {
  await ensureSchema();
  const res = await getPool().query(
    `UPDATE job_runs
       SET status = 'failed',
           failure_class = 'orphaned',
           error = COALESCE(error, 'Run did not report completion before its lease expired (process crash or hang).'),
           lease_expires_at = NULL,
           updated_at = now()
     WHERE status = 'running'
       AND lease_expires_at IS NOT NULL
       AND lease_expires_at < now()`
  );
  return res.rowCount ?? 0;
}

/** Delete rows past the retention window. Returns the number evicted. */
export async function evictOldRuns(
  retentionDays = DEFAULT_RETENTION_DAYS
): Promise<number> {
  await ensureSchema();
  const res = await getPool().query(
    `DELETE FROM job_runs WHERE created_at < now() - ($1 || ' days')::interval`,
    [retentionDays]
  );
  return res.rowCount ?? 0;
}

// --- Read path ---

export type RunStatusFilter = "all" | "failed" | "active";

export async function listRuns(
  filter: { status?: RunStatusFilter; limit?: number } = {}
): Promise<JobRun[]> {
  await ensureSchema();
  const where: string[] = [];
  const params: (string | number)[] = [];

  if (filter.status === "failed") where.push(`status = 'failed'`);
  else if (filter.status === "active") where.push(`status = 'running'`);

  params.push(filter.limit ?? 50);
  const sql = `SELECT * FROM job_runs
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY created_at DESC
     LIMIT $${params.length}`;

  const res = await getPool().query(sql, params);
  return res.rows.map(rowToJobRun);
}

export async function getRun(id: string): Promise<JobRun | null> {
  await ensureSchema();
  const res = await getPool().query(`SELECT * FROM job_runs WHERE id = $1`, [id]);
  if (res.rows.length === 0) return null;
  return rowToJobRun(res.rows[0]);
}

// --- Replay ---

export interface ReplayResult {
  /** The id of the new run row created by the replay. */
  runId: string;
}

/**
 * Re-run a ledgered job. Reconstructs the original call from the envelope and
 * dispatches to the same code path that ran it the first time, tagging the new
 * run as a replay of the original. This is a LIVE replay — the agent runs and
 * may re-deliver real messages/emails (the portal confirms before calling).
 *
 * Scheduled/triggered replays run as a manual trigger so they never shift the
 * live schedule.
 */
export async function replayRun(id: string): Promise<ReplayResult> {
  const original = await getRun(id);
  if (!original) {
    throw new Error(`Run ${id} not found (it may have been evicted).`);
  }
  const env = original.envelope;

  switch (env.source) {
    case "scheduler":
    case "trigger": {
      const { executeJob } = await import("./scheduler");
      const result = await executeJob(env.job, { source: "trigger", replayOf: id });
      return { runId: result.runId ?? id };
    }
    case "inbound": {
      const { handleInboundMessage } = await import("./messaging");
      const replyFn = await reconstructReplyFn(env.params.replyTarget);
      const result = await handleInboundMessage(
        { ...env.params, replyFn },
        { replayOf: id }
      );
      return { runId: result.runId ?? id };
    }
    case "portal": {
      const { runPortalAgent } = await import("./portal-run");
      const result = await runPortalAgent(env.input, { replayOf: id });
      return { runId: result.runId ?? id };
    }
  }
}

/**
 * Rebuild a channel reply function from a stored reply target. For inbound runs
 * (all `deliveryMode: "tool"`) this is used only for the error-notice path —
 * the agent's own `reply` tool handles normal delivery via IGNIS_REPLY_TARGET,
 * which handleInboundMessage re-injects from the same target.
 */
async function reconstructReplyFn(
  target?: ReplyTarget
): Promise<(text: string) => Promise<void>> {
  if (!target) return async () => {};
  switch (target.channel) {
    case "slack": {
      const { replyInThread } = await import("./slack");
      return async (text) => {
        if (target.slack) {
          await replyInThread(target.slack.channel, target.slack.threadTs, text);
        }
      };
    }
    case "telegram": {
      const { sendTelegramMessage } = await import("./telegram");
      return async (text) => {
        if (target.telegram) {
          await sendTelegramMessage(target.telegram.chatId, text, {
            replyToMessageId: target.telegram.replyToMessageId,
          });
        }
      };
    }
    case "email": {
      const { replyToEmail } = await import("./email");
      return async (text) => {
        if (target.email) {
          const cleaned = text.replace(/\nhttps?:\/\/[^\s]+$/, "").trim();
          await replyToEmail(target.email.messageId, cleaned);
        }
      };
    }
  }
}

// --- Helpers ---

function rowToJobRun(row: Record<string, unknown>): JobRun {
  const envelope = row.envelope;
  return {
    id: row.id as string,
    replay_of: (row.replay_of as string | null) ?? null,
    source: row.source as RunSource,
    profile: (row.profile as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    status: row.status as RunStatus,
    failure_class: (row.failure_class as FailureClass | null) ?? null,
    error: (row.error as string | null) ?? null,
    envelope: (typeof envelope === "string"
      ? JSON.parse(envelope)
      : envelope) as RunEnvelope,
    trace_id: (row.trace_id as string | null) ?? null,
    session_id: (row.session_id as string | null) ?? null,
    tokens: row.tokens == null ? null : Number(row.tokens),
    lease_expires_at: row.lease_expires_at
      ? (row.lease_expires_at as Date).toISOString()
      : null,
    created_at: (row.created_at as Date).toISOString(),
    updated_at: (row.updated_at as Date).toISOString(),
  };
}
