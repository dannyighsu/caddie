/**
 * Redis Client
 *
 * Upstash Redis wrapper for scheduling, active run locking, and session mapping.
 * Combines check-in and X Manager scheduling into a unified interface.
 */

import { Redis } from "@upstash/redis";

let redis: Redis | null = null;

function getRedis(): Redis {
  if (!redis) {
    const url = process.env.KV_REST_API_URL;
    const token = process.env.KV_REST_API_TOKEN;
    if (!url || !token) {
      throw new Error("KV_REST_API_URL and KV_REST_API_TOKEN must be set");
    }
    redis = new Redis({ url, token });
  }
  return redis;
}

// --- Active Run Locking ---

export async function setActiveRun(
  workflowId: string,
  ttlSeconds = 900 // 15 min default
): Promise<void> {
  await getRedis().set(`northstar:active:${workflowId}`, Date.now(), {
    ex: ttlSeconds,
  });
}

export async function isRunActive(workflowId: string): Promise<boolean> {
  const val = await getRedis().get(`northstar:active:${workflowId}`);
  return val !== null;
}

export async function clearActiveRun(workflowId: string): Promise<void> {
  await getRedis().del(`northstar:active:${workflowId}`);
}

// --- Scheduling ---

interface ScheduleEntry {
  workflowId: string;
  scheduledTime: number; // epoch ms
  metadata?: Record<string, unknown>;
}

const SCHEDULE_QUEUE = "northstar:schedule:queue";
const SCHEDULE_DETAIL_PREFIX = "northstar:schedule:detail:";

export async function scheduleRun(
  workflowId: string,
  scheduledTime: Date,
  metadata?: Record<string, unknown>
): Promise<void> {
  const score = scheduledTime.getTime();
  const member = `${workflowId}:${score}`;

  await getRedis().zadd(SCHEDULE_QUEUE, { score, member });
  await getRedis().set(
    `${SCHEDULE_DETAIL_PREFIX}${member}`,
    JSON.stringify({ workflowId, scheduledTime: score, metadata, status: "pending" }),
    { ex: 86400 } // 24h TTL
  );
}

export async function getDueRuns(): Promise<ScheduleEntry[]> {
  const now = Date.now();
  const members = await getRedis().zrange(SCHEDULE_QUEUE, 0, now, { byScore: true });
  const entries: ScheduleEntry[] = [];

  for (const member of members) {
    const detail = await getRedis().get(`${SCHEDULE_DETAIL_PREFIX}${member}`);
    if (detail) {
      const parsed = typeof detail === "string" ? JSON.parse(detail) : detail;
      if (parsed.status === "pending") {
        entries.push(parsed as ScheduleEntry);
      }
    }
  }

  return entries;
}

export async function markRunTriggered(
  workflowId: string,
  scheduledTime: number
): Promise<void> {
  const member = `${workflowId}:${scheduledTime}`;
  await getRedis().zrem(SCHEDULE_QUEUE, member);
  await getRedis().set(
    `${SCHEDULE_DETAIL_PREFIX}${member}`,
    JSON.stringify({ workflowId, scheduledTime, status: "triggered" }),
    { ex: 86400 }
  );
}

export async function getNextScheduledRun(
  workflowId: string
): Promise<{ scheduledTime: Date } | null> {
  const members = await getRedis().zrange(SCHEDULE_QUEUE, 0, -1, {
    withScores: true,
  });

  for (let i = 0; i < members.length; i += 2) {
    const member = members[i] as string;
    const score = members[i + 1] as number;
    if (member.startsWith(`${workflowId}:`)) {
      return { scheduledTime: new Date(score) };
    }
  }

  return null;
}

export async function cancelAllRuns(workflowId: string): Promise<number> {
  const members = await getRedis().zrange(SCHEDULE_QUEUE, 0, -1);
  let cancelled = 0;

  for (const member of members) {
    if ((member as string).startsWith(`${workflowId}:`)) {
      await getRedis().zrem(SCHEDULE_QUEUE, member);
      await getRedis().del(`${SCHEDULE_DETAIL_PREFIX}${member}`);
      cancelled++;
    }
  }

  return cancelled;
}
