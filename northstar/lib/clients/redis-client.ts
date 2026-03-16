import { Redis } from "@upstash/redis";
import { getAppConfig } from "../config/app-config";

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (redis) {
    return redis;
  }

  const config = getAppConfig();

  console.log(`[Redis] Initializing Upstash REST client`);

  redis = new Redis({
    url: config.KV_REST_API_URL,
    token: config.KV_REST_API_TOKEN,
    automaticDeserialization: false,
  });

  return redis;
}

// Check-in scheduling functions

const CHECKIN_QUEUE_KEY = "northstar:checkin:queue";
const CHECKIN_DETAILS_PREFIX = "northstar:checkin:details:";

export interface ScheduledCheckIn {
  userId: string;
  scheduledTime: number;
  status: "pending" | "triggered" | "completed";
  metadata?: Record<string, unknown>;
}

export async function scheduleCheckIn(
  userId: string,
  scheduledTime: Date,
  metadata?: Record<string, unknown>
): Promise<void> {
  const client = getRedis();
  const timestamp = scheduledTime.getTime();
  const checkInId = `${userId}:${timestamp}`;

  // Cancel any existing pending check-ins for this user first
  await cancelAllUserCheckIns(userId);

  // Add to sorted set for querying due check-ins
  await client.zadd(CHECKIN_QUEUE_KEY, {
    score: timestamp,
    member: checkInId,
  });

  // Store check-in details
  const details: ScheduledCheckIn = {
    userId,
    scheduledTime: timestamp,
    status: "pending",
    metadata,
  };

  await client.set(
    `${CHECKIN_DETAILS_PREFIX}${checkInId}`,
    JSON.stringify(details),
    { ex: 86400 * 7 } // 7 day TTL
  );

  console.log(
    `[Redis] Scheduled check-in for user ${userId} at ${scheduledTime.toISOString()}`
  );
}

export async function getDueCheckIns(): Promise<ScheduledCheckIn[]> {
  const client = getRedis();
  const now = Date.now();

  // Get all check-ins due before now
  const dueIds = await client.zrange(CHECKIN_QUEUE_KEY, 0, now, { byScore: true });

  const checkIns: ScheduledCheckIn[] = [];
  for (const id of dueIds) {
    const details = await client.get(`${CHECKIN_DETAILS_PREFIX}${id}`);
    if (details) {
      const checkIn = JSON.parse(details as string) as ScheduledCheckIn;
      if (checkIn.status === "pending") {
        checkIns.push(checkIn);
      }
    }
  }

  return checkIns;
}

export async function markCheckInTriggered(
  userId: string,
  scheduledTime: number
): Promise<void> {
  const client = getRedis();
  const checkInId = `${userId}:${scheduledTime}`;
  const key = `${CHECKIN_DETAILS_PREFIX}${checkInId}`;

  const details = await client.get(key);
  if (details) {
    const checkIn = JSON.parse(details as string) as ScheduledCheckIn;
    checkIn.status = "triggered";
    await client.set(key, JSON.stringify(checkIn), { ex: 86400 * 7 });
  }

  // Remove from queue
  await client.zrem(CHECKIN_QUEUE_KEY, checkInId);
}

export async function markCheckInCompleted(
  userId: string,
  scheduledTime: number
): Promise<void> {
  const client = getRedis();
  const checkInId = `${userId}:${scheduledTime}`;
  const key = `${CHECKIN_DETAILS_PREFIX}${checkInId}`;

  const details = await client.get(key);
  if (details) {
    const checkIn = JSON.parse(details as string) as ScheduledCheckIn;
    checkIn.status = "completed";
    await client.set(key, JSON.stringify(checkIn), { ex: 86400 }); // Keep for 1 day after completion
  }
}

export async function getNextScheduledCheckIn(
  userId: string
): Promise<ScheduledCheckIn | null> {
  const client = getRedis();

  // Get all future check-ins for this user
  const allIds = await client.zrange(CHECKIN_QUEUE_KEY, 0, -1);
  const userIds = (allIds as string[]).filter((id) => id.startsWith(`${userId}:`));

  if (userIds.length === 0) {
    return null;
  }

  // Get the earliest one
  const firstId = userIds[0];
  const details = await client.get(`${CHECKIN_DETAILS_PREFIX}${firstId}`);

  if (!details) {
    return null;
  }

  return JSON.parse(details as string) as ScheduledCheckIn;
}

export async function cancelScheduledCheckIn(
  userId: string,
  scheduledTime: number
): Promise<boolean> {
  const client = getRedis();
  const checkInId = `${userId}:${scheduledTime}`;

  const removed = await client.zrem(CHECKIN_QUEUE_KEY, checkInId);
  await client.del(`${CHECKIN_DETAILS_PREFIX}${checkInId}`);

  return removed > 0;
}

export async function cancelAllUserCheckIns(userId: string): Promise<number> {
  const client = getRedis();

  // Get all check-ins in the queue
  const allIds = await client.zrange(CHECKIN_QUEUE_KEY, 0, -1);
  const userIds = (allIds as string[]).filter((id) => id.startsWith(`${userId}:`));

  if (userIds.length === 0) {
    return 0;
  }

  // Remove all user check-ins from queue and delete details
  for (const id of userIds) {
    await client.zrem(CHECKIN_QUEUE_KEY, id);
    await client.del(`${CHECKIN_DETAILS_PREFIX}${id}`);
  }

  console.log(`[Redis] Cancelled ${userIds.length} pending check-in(s) for user ${userId}`);
  return userIds.length;
}

export async function clearAllPendingCheckIns(): Promise<number> {
  const client = getRedis();

  // Get all check-ins in the queue
  const allIds = await client.zrange(CHECKIN_QUEUE_KEY, 0, -1);

  if (allIds.length === 0) {
    return 0;
  }

  // Delete all check-in details
  for (const id of allIds) {
    await client.del(`${CHECKIN_DETAILS_PREFIX}${id}`);
  }

  // Clear the entire queue
  await client.del(CHECKIN_QUEUE_KEY);

  console.log(`[Redis] Cleared ${allIds.length} pending check-in(s) from queue`);
  return allIds.length;
}

// Active run tracking (to prevent concurrent runs)
const ACTIVE_RUN_PREFIX = "northstar:active:";

export async function setActiveRun(
  userId: string,
  ttlSeconds = 600
): Promise<void> {
  const client = getRedis();
  await client.set(`${ACTIVE_RUN_PREFIX}${userId}`, "1", { ex: ttlSeconds });
}

export async function isRunActive(userId: string): Promise<boolean> {
  const client = getRedis();
  const value = await client.get(`${ACTIVE_RUN_PREFIX}${userId}`);
  return value === "1";
}

export async function clearActiveRun(userId: string): Promise<void> {
  const client = getRedis();
  await client.del(`${ACTIVE_RUN_PREFIX}${userId}`);
}

export async function clearAllActiveRuns(): Promise<number> {
  const client = getRedis();
  const pattern = `${ACTIVE_RUN_PREFIX}*`;

  // Get all active run keys
  const keys = await client.keys(pattern);

  if (keys.length === 0) {
    return 0;
  }

  // Delete all active run keys
  await client.del(...keys);
  console.log(`[Redis] Cleared ${keys.length} stale active run(s)`);

  return keys.length;
}
