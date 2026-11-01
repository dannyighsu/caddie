/**
 * Redis Client
 *
 * ioredis wrapper for the job scheduler and active run locking.
 * Connects via REDIS_URL (standard connection string, e.g., from Railway).
 */

import Redis from "ioredis";
import type { NotificationChannel } from "./notification-channels";
import type { TrustTier } from "./identity";
import { computeDeferral } from "./defer";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error("REDIS_URL environment variable is not set");
    }
    redis = new Redis(url);
  }
  return redis;
}

// =============================================================================
// Active Run Locking
// =============================================================================

export async function setActiveRun(
  key: string,
  ttlSeconds = 900
): Promise<void> {
  await getRedis().set(
    `caddie:active:${key}`,
    String(Date.now()),
    "EX",
    ttlSeconds
  );
}

export async function isRunActive(key: string): Promise<boolean> {
  const val = await getRedis().get(`caddie:active:${key}`);
  return val !== null;
}

export async function clearActiveRun(key: string): Promise<void> {
  await getRedis().del(`caddie:active:${key}`);
}

/**
 * Atomically acquire the active-run lock for a key.
 *
 * Returns true if the lock was acquired, false if a run is already active
 * (Redis SET NX). Use this — rather than a separate isRunActive/setActiveRun
 * pair — to avoid a check-then-set race between the scheduler poller and a
 * manual "run now" trigger. Always pair a successful acquire with
 * clearActiveRun in a finally block.
 */
export async function acquireActiveRun(
  key: string,
  ttlSeconds = 900
): Promise<boolean> {
  const res = await getRedis().set(
    `caddie:active:${key}`,
    String(Date.now()),
    "EX",
    ttlSeconds,
    "NX"
  );
  return res === "OK";
}

// =============================================================================
// Inbound Message Dedup
// =============================================================================

/**
 * How long a handled inbound message stays claimed. Long enough to outlive
 * anything that can make an old message UNREAD again (a person marking the
 * thread unread, a failed mark-read, a restart); a message older than this that
 * reappears is treated as new.
 */
const INBOUND_CLAIM_TTL_SECONDS = 180 * 24 * 60 * 60;

/**
 * Atomically claim an inbound Gmail message for dispatch. Returns false if it
 * was already claimed — by an earlier poll, a previous process, or a concurrent
 * poller — so it is never handed to the agent twice. Release the claim only if
 * dispatch fails and the message should be retried.
 */
export async function claimInboundMessage(gmailId: string): Promise<boolean> {
  const res = await getRedis().set(
    `caddie:inbound:gmail:${gmailId}`,
    String(Date.now()),
    "EX",
    INBOUND_CLAIM_TTL_SECONDS,
    "NX"
  );
  return res === "OK";
}

export async function releaseInboundMessage(gmailId: string): Promise<void> {
  await getRedis().del(`caddie:inbound:gmail:${gmailId}`);
}

// =============================================================================
// Job Scheduler
// =============================================================================

/**
 * A scheduled job definition stored in Redis.
 *
 * - Recurring jobs have a `cron` expression. After firing, `nextRun` is recomputed.
 * - One-shot jobs have no `cron`. After firing, they're removed.
 */
export interface ScheduledJob {
  /** Unique job identifier. */
  id: string;
  /** Job action type: "run" (default) launches the agent, "notify" sends a notification. */
  action?: "run" | "notify";
  /** Profile to use (optional). */
  profile?: string;
  /** Cron expression for recurring jobs (e.g., "0 9 * * 2" = Tuesdays 9AM). Omit for one-shot. */
  cron?: string;
  /** Precomputed next run time (epoch ms). */
  nextRun: number;
  /**
   * Set only while a recurring occurrence is being deferred because the
   * active-run lock was busy (see `deferRecurringJob`): the epoch-ms time of the
   * occurrence's own next natural cron fire, which the retries must not pass.
   * Cleared whenever the job fires.
   */
  deferDeadline?: number;
  /** Whether the job is active. */
  enabled: boolean;
  /** Optional params passed to the launcher. */
  params?: Record<string, unknown>;
  /** Human-readable description. */
  description?: string;
  /**
   * Channel to send notifications/results to. Defaults to "slack".
   * Applies to both "notify" jobs and failure notifications from "run" jobs.
   */
  notificationChannel?: NotificationChannel;
  /**
   * Channel-specific recipient override (Slack channel ID, phone number, email).
   * If omitted, the channel's configured default is used.
   */
  notificationRecipient?: string;
  /**
   * Trust tier the agent run launches at. Scheduled/triggered runs are the
   * team's own automations, so they default to "team" (giving access
   * to team-gated capabilities like email/notion/calendar). Pin to "guest"
   * for a job that should run least-privilege. Only applies to "run" jobs.
   */
  trustTier?: TrustTier;
}

const JOBS_HASH = "caddie:jobs";
const JOBS_QUEUE = "caddie:jobs:queue";

/**
 * Serialize a job to JSON for Redis storage.
 */
function serializeJob(job: ScheduledJob): string {
  return JSON.stringify(job);
}

/**
 * Deserialize a job from Redis.
 */
function deserializeJob(data: string): ScheduledJob {
  return JSON.parse(data) as ScheduledJob;
}

/**
 * Compute the next occurrence from a cron expression after a given time.
 */
async function computeNextRun(cronExpr: string, after: Date = new Date()): Promise<number> {
  const { CronExpressionParser } = await import("cron-parser");
  const interval = CronExpressionParser.parse(cronExpr, { currentDate: after });
  return interval.next().getTime();
}

/**
 * Create or update a scheduled job.
 */
export async function upsertJob(job: ScheduledJob): Promise<void> {
  const r = getRedis();
  await r.hset(JOBS_HASH, job.id, serializeJob(job));
  if (job.enabled) {
    await r.zadd(JOBS_QUEUE, job.nextRun, job.id);
  } else {
    await r.zrem(JOBS_QUEUE, job.id);
  }
}

/**
 * Schedule a one-shot run at a specific time.
 */
export async function scheduleOneShot(
  runAt: Date,
  options?: {
    profile?: string;
    params?: Record<string, unknown>;
    description?: string;
    notificationChannel?: NotificationChannel;
    notificationRecipient?: string;
    trustTier?: TrustTier;
  }
): Promise<ScheduledJob> {
  const job: ScheduledJob = {
    id: `oneshot:run:${runAt.getTime()}`,
    profile: options?.profile,
    nextRun: runAt.getTime(),
    enabled: true,
    params: options?.params,
    description: options?.description,
    notificationChannel: options?.notificationChannel,
    notificationRecipient: options?.notificationRecipient,
    trustTier: options?.trustTier,
  };
  await upsertJob(job);
  return job;
}

/**
 * Schedule a one-shot notification at a specific time.
 */
export async function scheduleNotification(
  runAt: Date,
  options: {
    message: string;
    from?: string;
    description?: string;
    notificationChannel?: NotificationChannel;
    notificationRecipient?: string;
  }
): Promise<ScheduledJob> {
  const job: ScheduledJob = {
    id: `oneshot:notify:${runAt.getTime()}`,
    action: "notify",
    nextRun: runAt.getTime(),
    enabled: true,
    params: {
      message: options.message,
      from: options.from,
    },
    description: options.description ?? options.message,
    notificationChannel: options.notificationChannel,
    notificationRecipient: options.notificationRecipient,
  };
  await upsertJob(job);
  return job;
}

/**
 * Schedule a recurring job with a cron expression.
 */
export async function scheduleRecurring(
  id: string,
  cronExpr: string,
  options?: {
    profile?: string;
    params?: Record<string, unknown>;
    description?: string;
    notificationChannel?: NotificationChannel;
    notificationRecipient?: string;
    trustTier?: TrustTier;
  }
): Promise<ScheduledJob> {
  const nextRun = await computeNextRun(cronExpr);
  const job: ScheduledJob = {
    id,
    profile: options?.profile,
    cron: cronExpr,
    nextRun,
    enabled: true,
    params: options?.params,
    description: options?.description,
    notificationChannel: options?.notificationChannel,
    notificationRecipient: options?.notificationRecipient,
    trustTier: options?.trustTier,
  };
  await upsertJob(job);
  return job;
}

/**
 * Get all due jobs (nextRun <= now).
 */
export async function getDueJobs(): Promise<ScheduledJob[]> {
  const r = getRedis();
  const now = Date.now();
  const jobIds = await r.zrangebyscore(JOBS_QUEUE, 0, now);
  const jobs: ScheduledJob[] = [];

  for (const id of jobIds) {
    const data = await r.hget(JOBS_HASH, id);
    if (data) {
      const job = deserializeJob(data);
      if (job.enabled) jobs.push(job);
    }
  }

  return jobs;
}

/**
 * Mark a job as fired. Recurring jobs get rescheduled; one-shot jobs are removed.
 */
export async function markJobFired(jobId: string): Promise<void> {
  const r = getRedis();
  const data = await r.hget(JOBS_HASH, jobId);
  if (!data) return;

  const job = deserializeJob(data);

  if (job.cron) {
    // Recurring: compute next occurrence and reschedule. Firing ends any
    // deferral of the previous occurrence, so the deadline goes away with it.
    job.nextRun = await computeNextRun(job.cron);
    delete job.deferDeadline;
    await upsertJob(job);
  } else {
    // One-shot: remove entirely
    await r.hdel(JOBS_HASH, jobId);
    await r.zrem(JOBS_QUEUE, jobId);
  }
}

/**
 * Get a specific job by ID.
 */
export async function getJob(id: string): Promise<ScheduledJob | null> {
  const data = await getRedis().hget(JOBS_HASH, id);
  return data ? deserializeJob(data) : null;
}

/**
 * List all jobs.
 */
export async function listJobs(): Promise<ScheduledJob[]> {
  const all = await getRedis().hgetall(JOBS_HASH);
  return Object.values(all).map(deserializeJob);
}

/**
 * Delete a job.
 */
export async function deleteJob(id: string): Promise<void> {
  const r = getRedis();
  await r.hdel(JOBS_HASH, id);
  await r.zrem(JOBS_QUEUE, id);
}

/**
 * Override the next run time for a job.
 * Used when agent output specifies a preferred next run time that takes
 * priority over the cron-computed schedule.
 */
export async function overrideNextRun(id: string, nextRun: Date): Promise<void> {
  const data = await getRedis().hget(JOBS_HASH, id);
  if (!data) return;
  const job = deserializeJob(data);
  job.nextRun = nextRun.getTime();
  await upsertJob(job);
}

/**
 * Push a recurring occurrence a little further out because it couldn't acquire
 * the active-run lock, so it is retried instead of lost.
 *
 * `markJobFired` has already advanced `nextRun` to the next natural cron
 * occurrence by the time we know the lock was busy, so "it just fires again
 * next tick" doesn't hold — without this the blocked occurrence is dropped
 * silently. The retry never lands past that natural occurrence (the deadline),
 * so a deferral can't displace a later fire or loop forever.
 *
 * Returns the new run time, or null if the occurrence wasn't deferred (not a
 * recurring job, or its natural occurrence is already due and will cover it).
 */
export async function deferRecurringJob(
  id: string,
  delayMs?: number
): Promise<Date | null> {
  const r = getRedis();
  const data = await r.hget(JOBS_HASH, id);
  if (!data) return null;
  const job = deserializeJob(data);
  if (!job.cron) return null;

  const deferral = computeDeferral({
    now: Date.now(),
    naturalNext: job.nextRun,
    deadline: job.deferDeadline,
    delayMs,
  });

  if (!deferral) {
    // Out of runway — leave nextRun alone and stop carrying the deadline.
    if (job.deferDeadline !== undefined) {
      delete job.deferDeadline;
      await upsertJob(job);
    }
    return null;
  }

  job.nextRun = deferral.nextRun;
  job.deferDeadline = deferral.deadline;
  await upsertJob(job);
  return new Date(deferral.nextRun);
}

/**
 * Enable or disable a job.
 */
export async function setJobEnabled(id: string, enabled: boolean): Promise<void> {
  const data = await getRedis().hget(JOBS_HASH, id);
  if (!data) return;
  const job = deserializeJob(data);
  job.enabled = enabled;
  await upsertJob(job);
}
