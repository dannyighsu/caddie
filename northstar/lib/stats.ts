/**
 * Portal Overview Stats
 *
 * Cheap aggregate counters for the homepage, all sourced from the `job_runs`
 * ledger (the single record of every execution) over a time window:
 *   - runs / failed runs
 *   - total tokens spent (summed from each run's recorded usage)
 *   - inbound messages per channel (source='inbound', excluding replays)
 *
 * The window maxes out at the ledger's 7-day retention, which is exactly the
 * longest range we offer.
 */

import { getPool, ensureSchema } from "./db";

export type StatsRange = "24h" | "7d";

const RANGE_HOURS: Record<StatsRange, number> = { "24h": 24, "7d": 24 * 7 };

/** Channels we always show a tile for, even at zero. */
const KNOWN_CHANNELS = ["email", "slack", "telegram"] as const;

export interface PortalStats {
  range: StatsRange;
  runs: number;
  failed: number;
  /** Total tokens across runs in the window; null if no run recorded usage. */
  tokens: number | null;
  messagesByChannel: { channel: string; count: number }[];
  messagesTotal: number;
}

export function isStatsRange(v: unknown): v is StatsRange {
  return v === "24h" || v === "7d";
}

export async function getPortalStats(range: StatsRange): Promise<PortalStats> {
  await ensureSchema();
  const hours = RANGE_HOURS[range];
  const pool = getPool();

  const [agg, byChannel] = await Promise.all([
    pool.query(
      `SELECT
         count(*)::int AS runs,
         count(*) FILTER (WHERE status = 'failed')::int AS failed,
         SUM(tokens) AS tokens
       FROM job_runs
       WHERE created_at >= now() - ($1 || ' hours')::interval`,
      [hours],
    ),
    pool.query(
      `SELECT COALESCE(envelope->'params'->'context'->>'originChannel', 'unknown') AS channel,
              count(*)::int AS count
       FROM job_runs
       WHERE source = 'inbound'
         AND replay_of IS NULL
         AND created_at >= now() - ($1 || ' hours')::interval
       GROUP BY 1`,
      [hours],
    ),
  ]);

  // Seed known channels at 0, then merge in actual counts (extras appended).
  const counts = new Map<string, number>(KNOWN_CHANNELS.map((c) => [c, 0]));
  for (const row of byChannel.rows) {
    const channel = row.channel as string;
    counts.set(channel, (counts.get(channel) ?? 0) + Number(row.count));
  }

  const messagesByChannel = [...counts.entries()].map(([channel, count]) => ({ channel, count }));
  const messagesTotal = messagesByChannel.reduce((sum, c) => sum + c.count, 0);

  const row = agg.rows[0] ?? {};
  return {
    range,
    runs: Number(row.runs ?? 0),
    failed: Number(row.failed ?? 0),
    tokens: row.tokens == null ? null : Number(row.tokens),
    messagesByChannel,
    messagesTotal,
  };
}
