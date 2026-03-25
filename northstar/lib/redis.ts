/**
 * Redis Client
 *
 * ioredis wrapper for scheduling, active run locking, and session mapping.
 * Connects via REDIS_URL (standard connection string, e.g., from Railway).
 */

import Redis from "ioredis";

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

// --- Active Run Locking ---

export async function setActiveRun(
  agentId: string,
  ttlSeconds = 900
): Promise<void> {
  await getRedis().set(
    `northstar:active:${agentId}`,
    String(Date.now()),
    "EX",
    ttlSeconds
  );
}

export async function isRunActive(agentId: string): Promise<boolean> {
  const val = await getRedis().get(`northstar:active:${agentId}`);
  return val !== null;
}

export async function clearActiveRun(agentId: string): Promise<void> {
  await getRedis().del(`northstar:active:${agentId}`);
}

// --- Scheduling ---

interface ScheduleEntry {
  agentId: string;
  scheduledTime: number; // epoch ms
  metadata?: Record<string, unknown>;
}

const SCHEDULE_QUEUE = "northstar:schedule:queue";
const SCHEDULE_DETAIL_PREFIX = "northstar:schedule:detail:";

export async function scheduleRun(
  agentId: string,
  scheduledTime: Date,
  metadata?: Record<string, unknown>
): Promise<void> {
  const score = scheduledTime.getTime();
  const member = `${agentId}:${score}`;

  await getRedis().zadd(SCHEDULE_QUEUE, score, member);
  await getRedis().set(
    `${SCHEDULE_DETAIL_PREFIX}${member}`,
    JSON.stringify({ agentId, scheduledTime: score, metadata, status: "pending" }),
    "EX",
    86400
  );
}

export async function getDueRuns(): Promise<ScheduleEntry[]> {
  const now = Date.now();
  const members = await getRedis().zrangebyscore(SCHEDULE_QUEUE, 0, now);
  const entries: ScheduleEntry[] = [];

  for (const member of members) {
    const detail = await getRedis().get(`${SCHEDULE_DETAIL_PREFIX}${member}`);
    if (detail) {
      const parsed = JSON.parse(detail);
      if (parsed.status === "pending") {
        entries.push(parsed as ScheduleEntry);
      }
    }
  }

  return entries;
}

export async function markRunTriggered(
  agentId: string,
  scheduledTime: number
): Promise<void> {
  const member = `${agentId}:${scheduledTime}`;
  await getRedis().zrem(SCHEDULE_QUEUE, member);
  await getRedis().set(
    `${SCHEDULE_DETAIL_PREFIX}${member}`,
    JSON.stringify({ agentId, scheduledTime, status: "triggered" }),
    "EX",
    86400
  );
}

export async function getNextScheduledRun(
  agentId: string
): Promise<{ scheduledTime: Date } | null> {
  const results = await getRedis().zrangebyscore(
    SCHEDULE_QUEUE,
    0,
    "+inf",
    "WITHSCORES"
  );

  // Results come as [member, score, member, score, ...]
  for (let i = 0; i < results.length; i += 2) {
    const member = results[i];
    const score = parseInt(results[i + 1], 10);
    if (member.startsWith(`${agentId}:`)) {
      return { scheduledTime: new Date(score) };
    }
  }

  return null;
}

export async function cancelAllRuns(agentId: string): Promise<number> {
  const members = await getRedis().zrange(SCHEDULE_QUEUE, 0, -1);
  let cancelled = 0;

  for (const member of members) {
    if (member.startsWith(`${agentId}:`)) {
      await getRedis().zrem(SCHEDULE_QUEUE, member);
      await getRedis().del(`${SCHEDULE_DETAIL_PREFIX}${member}`);
      cancelled++;
    }
  }

  return cancelled;
}
