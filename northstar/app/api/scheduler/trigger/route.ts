/**
 * Scheduler Trigger Route
 *
 * Called by an external scheduler (cron, Azure Functions, etc.) to process
 * due agent runs. Polls Redis for scheduled items and fires each via the gateway.
 */

import { getDueRuns, markRunTriggered } from "@/lib/redis";
import { getOrchestrator } from "@/lib/orchestrators";
import { NextResponse } from "next/server";

export async function POST() {
  try {
    const dueRuns = await getDueRuns();

    if (dueRuns.length === 0) {
      return NextResponse.json({ triggered: 0, results: [] });
    }

    const results: Array<{
      agentId: string;
      success: boolean;
      error?: string;
    }> = [];

    for (const entry of dueRuns) {
      const agentId = entry.agentId;

      await markRunTriggered(agentId, entry.scheduledTime);

      try {
        const orchestrator = getOrchestrator(agentId);
        if (orchestrator) {
          const data = await orchestrator(entry.metadata as Record<string, string> ?? {});
          results.push({
            agentId,
            success: !!data.success,
            error: data.error as string | undefined,
          });
        } else {
          console.warn(`[Scheduler] No orchestrator for agent "${agentId}", skipping`);
          results.push({ agentId, success: false, error: "No orchestrator configured" });
        }

        console.log(
          `[Scheduler] Triggered ${agentId}: ${results[results.length - 1].success ? "success" : "failed"}`
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : "Unknown error";
        console.error(`[Scheduler] Failed to trigger ${agentId}:`, error);
        results.push({ agentId, success: false, error });
      }
    }

    return NextResponse.json({ triggered: results.length, results });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Scheduler] Trigger failed:", error);
    return NextResponse.json({ error }, { status: 500 });
  }
}
