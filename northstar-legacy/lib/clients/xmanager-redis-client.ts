import { getRedis } from "./redis-client";

// X Manager Redis key prefixes
const XMANAGER_PREFIX = "northstar:xmanager:";
const XMANAGER_QUEUE_KEY = `${XMANAGER_PREFIX}queue`;
const XMANAGER_STATE_PREFIX = `${XMANAGER_PREFIX}state:`;
const XMANAGER_ACTIVE_PREFIX = `${XMANAGER_PREFIX}active:`;
const XMANAGER_DETAILS_PREFIX = `${XMANAGER_PREFIX}details:`;

/**
 * State information about the last X Manager run
 */
export interface XManagerRunState {
  userId: string;
  lastRunTime: number;
  lastRunSummary?: string;
  nextScheduledRun?: number;
}

/**
 * A scheduled X Manager run
 */
export interface ScheduledXManagerRun {
  userId: string;
  scheduledTime: number;
  status: "pending" | "triggered" | "completed";
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Active Run Tracking
// ============================================================================

/**
 * Set a flag indicating an X Manager run is active.
 * Uses TTL to auto-clear if process crashes.
 */
export async function setXManagerRunActive(
  userId: string,
  ttlSeconds = 900 // 15 minutes - browser automation may take longer
): Promise<void> {
  const client = getRedis();
  await client.set(`${XMANAGER_ACTIVE_PREFIX}${userId}`, "1", {
    ex: ttlSeconds,
  });
  console.log(`[XManager Redis] Set active run for user ${userId}`);
}

/**
 * Check if an X Manager run is currently active for a user.
 */
export async function isXManagerRunActive(userId: string): Promise<boolean> {
  const client = getRedis();
  const value = await client.get(`${XMANAGER_ACTIVE_PREFIX}${userId}`);
  return value === "1";
}

/**
 * Clear the active run flag for a user.
 */
export async function clearXManagerRunActive(userId: string): Promise<void> {
  const client = getRedis();
  await client.del(`${XMANAGER_ACTIVE_PREFIX}${userId}`);
  console.log(`[XManager Redis] Cleared active run for user ${userId}`);
}

/**
 * Clear all active X Manager runs (for startup cleanup).
 */
export async function clearAllXManagerActiveRuns(): Promise<number> {
  const client = getRedis();
  const pattern = `${XMANAGER_ACTIVE_PREFIX}*`;
  const keys = await client.keys(pattern);

  if (keys.length === 0) return 0;

  await client.del(...keys);
  console.log(`[XManager Redis] Cleared ${keys.length} stale active run(s)`);
  return keys.length;
}

// ============================================================================
// Run State Persistence
// ============================================================================

/**
 * Get the last run state for a user.
 */
export async function getLastXManagerRun(
  userId: string
): Promise<XManagerRunState | null> {
  const client = getRedis();
  const data = await client.get(`${XMANAGER_STATE_PREFIX}${userId}`);
  return data ? (JSON.parse(data as string) as XManagerRunState) : null;
}

/**
 * Set the run state for a user.
 */
export async function setXManagerRunState(
  userId: string,
  state: XManagerRunState
): Promise<void> {
  const client = getRedis();
  await client.set(
    `${XMANAGER_STATE_PREFIX}${userId}`,
    JSON.stringify(state),
    { ex: 86400 * 30 } // 30 day TTL
  );
}

// ============================================================================
// Scheduling
// ============================================================================

/**
 * Schedule an X Manager run.
 * Cancels any existing scheduled runs for the user first.
 */
export async function scheduleXManagerRun(
  userId: string,
  scheduledTime: Date,
  metadata?: { lastRunSummary?: string }
): Promise<void> {
  const client = getRedis();
  const timestamp = scheduledTime.getTime();
  const runId = `${userId}:${timestamp}`;

  // Cancel existing scheduled runs for this user
  await cancelAllXManagerRuns(userId);

  // Add to sorted set queue
  await client.zadd(XMANAGER_QUEUE_KEY, {
    score: timestamp,
    member: runId,
  });

  // Store run details
  const details: ScheduledXManagerRun = {
    userId,
    scheduledTime: timestamp,
    status: "pending",
    metadata,
  };

  await client.set(`${XMANAGER_DETAILS_PREFIX}${runId}`, JSON.stringify(details), {
    ex: 86400 * 7, // 7 day TTL
  });

  // Update state with next scheduled run
  await setXManagerRunState(userId, {
    userId,
    lastRunTime: Date.now(),
    lastRunSummary: metadata?.lastRunSummary,
    nextScheduledRun: timestamp,
  });

  console.log(
    `[XManager Redis] Scheduled run for ${userId} at ${scheduledTime.toISOString()}`
  );
}

/**
 * Get all X Manager runs that are due (past their scheduled time and pending).
 */
export async function getDueXManagerRuns(): Promise<ScheduledXManagerRun[]> {
  const client = getRedis();
  const now = Date.now();

  // Get all runs with scheduled time <= now
  const dueIds = await client.zrange(XMANAGER_QUEUE_KEY, 0, now, { byScore: true });

  const runs: ScheduledXManagerRun[] = [];
  for (const id of dueIds) {
    const details = await client.get(`${XMANAGER_DETAILS_PREFIX}${id}`);
    if (details) {
      const run = JSON.parse(details as string) as ScheduledXManagerRun;
      if (run.status === "pending") {
        runs.push(run);
      }
    }
  }

  return runs;
}

/**
 * Mark a scheduled run as triggered (removes from queue).
 */
export async function markXManagerRunTriggered(
  userId: string,
  scheduledTime: number
): Promise<void> {
  const client = getRedis();
  const runId = `${userId}:${scheduledTime}`;
  const key = `${XMANAGER_DETAILS_PREFIX}${runId}`;

  const details = await client.get(key);
  if (details) {
    const run = JSON.parse(details as string) as ScheduledXManagerRun;
    run.status = "triggered";
    await client.set(key, JSON.stringify(run), { ex: 86400 * 7 });
  }

  // Remove from queue
  await client.zrem(XMANAGER_QUEUE_KEY, runId);
  console.log(`[XManager Redis] Marked run as triggered: ${runId}`);
}

/**
 * Mark a scheduled run as completed.
 */
export async function markXManagerRunCompleted(
  userId: string,
  scheduledTime: number
): Promise<void> {
  const client = getRedis();
  const runId = `${userId}:${scheduledTime}`;
  const key = `${XMANAGER_DETAILS_PREFIX}${runId}`;

  const details = await client.get(key);
  if (details) {
    const run = JSON.parse(details as string) as ScheduledXManagerRun;
    run.status = "completed";
    await client.set(key, JSON.stringify(run), { ex: 86400 }); // Keep for 1 day
  }
}

/**
 * Cancel all scheduled X Manager runs for a user.
 */
export async function cancelAllXManagerRuns(userId: string): Promise<number> {
  const client = getRedis();
  const allIds = await client.zrange(XMANAGER_QUEUE_KEY, 0, -1);
  const userIds = (allIds as string[]).filter((id) => id.startsWith(`${userId}:`));

  if (userIds.length === 0) return 0;

  for (const id of userIds) {
    await client.zrem(XMANAGER_QUEUE_KEY, id);
    await client.del(`${XMANAGER_DETAILS_PREFIX}${id}`);
  }

  console.log(
    `[XManager Redis] Cancelled ${userIds.length} scheduled run(s) for ${userId}`
  );
  return userIds.length;
}

/**
 * Get the next scheduled X Manager run for a user.
 */
export async function getNextScheduledXManagerRun(
  userId: string
): Promise<ScheduledXManagerRun | null> {
  const client = getRedis();
  const allIds = await client.zrange(XMANAGER_QUEUE_KEY, 0, -1);
  const userIds = (allIds as string[]).filter((id) => id.startsWith(`${userId}:`));

  if (userIds.length === 0) return null;

  const details = await client.get(`${XMANAGER_DETAILS_PREFIX}${userIds[0]}`);
  return details ? (JSON.parse(details as string) as ScheduledXManagerRun) : null;
}

/**
 * Clear all pending X Manager runs (for startup cleanup).
 */
export async function clearAllPendingXManagerRuns(): Promise<number> {
  const client = getRedis();
  const allIds = await client.zrange(XMANAGER_QUEUE_KEY, 0, -1);

  if (allIds.length === 0) return 0;

  for (const id of allIds) {
    await client.del(`${XMANAGER_DETAILS_PREFIX}${id}`);
  }

  await client.del(XMANAGER_QUEUE_KEY);
  console.log(
    `[XManager Redis] Cleared ${allIds.length} pending run(s) from queue`
  );
  return allIds.length;
}
