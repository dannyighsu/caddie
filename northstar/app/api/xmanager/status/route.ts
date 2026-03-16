import { NextRequest, NextResponse } from "next/server";
import {
  getLastXManagerRun,
  getNextScheduledXManagerRun,
  isXManagerRunActive,
} from "@/lib/clients/xmanager-redis-client";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId") || "default";

    const [lastRun, nextRun, isActive] = await Promise.all([
      getLastXManagerRun(userId),
      getNextScheduledXManagerRun(userId),
      isXManagerRunActive(userId),
    ]);

    return NextResponse.json({
      userId,
      isRunning: isActive,
      lastRun: lastRun
        ? {
            time: new Date(lastRun.lastRunTime).toISOString(),
            summary: lastRun.lastRunSummary,
          }
        : null,
      nextScheduledRun: nextRun
        ? {
            time: new Date(nextRun.scheduledTime).toISOString(),
            status: nextRun.status,
          }
        : null,
    });
  } catch (error) {
    console.error("[API] X Manager status error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
