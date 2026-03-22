import { NextRequest, NextResponse } from "next/server";
import {
  scheduleXManagerRun,
  cancelAllXManagerRuns,
  getNextScheduledXManagerRun,
} from "@/lib/clients/xmanager-redis-client";

/**
 * POST: Schedule a new X Manager run
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const userId = body.userId || "default";
    const minutesFromNow = body.minutesFromNow || 60;

    if (minutesFromNow < 1) {
      return NextResponse.json(
        { success: false, error: "minutesFromNow must be at least 1" },
        { status: 400 }
      );
    }

    const scheduledTime = new Date(Date.now() + minutesFromNow * 60 * 1000);
    await scheduleXManagerRun(userId, scheduledTime);

    console.log(
      `[API] Scheduled X Manager run for ${userId} at ${scheduledTime.toISOString()}`
    );

    return NextResponse.json({
      success: true,
      scheduledTime: scheduledTime.toISOString(),
      minutesFromNow,
    });
  } catch (error) {
    console.error("[API] X Manager schedule error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * GET: Get the next scheduled run
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId") || "default";

    const nextRun = await getNextScheduledXManagerRun(userId);

    return NextResponse.json({
      userId,
      nextScheduledRun: nextRun
        ? {
            time: new Date(nextRun.scheduledTime).toISOString(),
            status: nextRun.status,
          }
        : null,
    });
  } catch (error) {
    console.error("[API] X Manager schedule get error:", error);
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}

/**
 * DELETE: Cancel all scheduled runs for a user
 */
export async function DELETE(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId") || "default";

    const cancelledCount = await cancelAllXManagerRuns(userId);

    console.log(
      `[API] Cancelled ${cancelledCount} X Manager run(s) for ${userId}`
    );

    return NextResponse.json({
      success: true,
      cancelledCount,
    });
  } catch (error) {
    console.error("[API] X Manager schedule delete error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
