import { NextRequest, NextResponse } from "next/server";
import { scheduleCheckIn } from "@/lib/clients/redis-client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { scheduledTime, userId = "default" } = body;

    if (!scheduledTime) {
      return NextResponse.json(
        { error: "scheduledTime is required" },
        { status: 400 }
      );
    }

    const scheduledDate = new Date(scheduledTime);
    if (isNaN(scheduledDate.getTime())) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 }
      );
    }

    if (scheduledDate <= new Date()) {
      return NextResponse.json(
        { error: "Scheduled time must be in the future" },
        { status: 400 }
      );
    }

    await scheduleCheckIn(userId, scheduledDate);

    console.log(
      `[Scheduler] Scheduled check-in for ${userId} at ${scheduledDate.toISOString()}`
    );

    return NextResponse.json({
      success: true,
      scheduledTime: scheduledDate.toISOString(),
    });
  } catch (error) {
    console.error("[Scheduler] Error scheduling check-in:", error);
    return NextResponse.json(
      { error: "Failed to schedule check-in" },
      { status: 500 }
    );
  }
}
