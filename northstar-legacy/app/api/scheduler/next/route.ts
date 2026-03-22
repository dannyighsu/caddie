import { NextResponse } from "next/server";
import { getNextScheduledCheckIn } from "@/lib/clients/redis-client";

export async function GET() {
  try {
    const nextCheckIn = await getNextScheduledCheckIn("default");

    return NextResponse.json({
      nextCheckIn: nextCheckIn
        ? {
            scheduledTime: nextCheckIn.scheduledTime,
            status: nextCheckIn.status,
          }
        : null,
    });
  } catch (error) {
    console.error("[Scheduler] Error getting next check-in:", error);
    return NextResponse.json(
      { error: "Failed to get next check-in" },
      { status: 500 }
    );
  }
}
