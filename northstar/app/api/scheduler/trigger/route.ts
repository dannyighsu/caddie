/**
 * Scheduler Trigger Route
 *
 * Called by an external scheduler (cron, Azure Functions, etc.) to process
 * due agent runs. Polls Redis for scheduled items and fires each one.
 */

import { getDueRuns, markRunTriggered } from "@/lib/redis";
import { NextResponse } from "next/server";

// Map agentId to the internal gateway route that handles it
const GATEWAY_ROUTES: Record<string, string> = {
  checkin: "/api/checkin/run",
  xmanager: "/api/xmanager/run",
};

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
      const agentId = entry.workflowId; // Redis still uses workflowId internally
      const route = GATEWAY_ROUTES[agentId];

      if (!route) {
        console.warn(`[Scheduler] No gateway route for agent "${agentId}", skipping`);
        results.push({ agentId, success: false, error: "No gateway route configured" });
        continue;
      }

      // Mark as triggered before executing (prevents re-triggering on slow runs)
      await markRunTriggered(agentId, entry.scheduledTime);

      try {
        // Call the gateway route internally
        const baseUrl = process.env.BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
        const res = await fetch(`${baseUrl}${route}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(entry.metadata ?? {}),
        });

        const data = await res.json();
        results.push({
          agentId,
          success: data.success ?? res.ok,
          error: data.error,
        });

        console.log(
          `[Scheduler] Triggered ${agentId}: ${data.success ? "success" : "failed"}`
        );
      } catch (err) {
        const error = err instanceof Error ? err.message : "Unknown error";
        console.error(`[Scheduler] Failed to trigger ${agentId}:`, error);
        results.push({ agentId, success: false, error });
      }
    }

    return NextResponse.json({
      triggered: results.length,
      results,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Scheduler] Trigger failed:", error);
    return NextResponse.json({ error }, { status: 500 });
  }
}
