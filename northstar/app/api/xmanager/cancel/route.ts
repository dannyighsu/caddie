import { NextRequest, NextResponse } from "next/server";
import { clearXManagerRunActive } from "@/lib/clients/xmanager-redis-client";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const userId = body.userId || "default";

    console.log(`[API] Cancelling X Manager run for user: ${userId}`);

    // Clear the active run lock
    await clearXManagerRunActive(userId);

    console.log(`[API] Successfully cancelled X Manager run for user: ${userId}`);

    return NextResponse.json({
      success: true,
      message: "Run cancelled successfully",
    });
  } catch (error) {
    console.error("[API] X Manager cancel error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
