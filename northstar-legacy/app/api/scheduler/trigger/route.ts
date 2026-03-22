import { NextRequest, NextResponse } from "next/server";
import {
  getDueCheckIns,
  markCheckInTriggered,
  markCheckInCompleted,
} from "@/lib/clients/redis-client";
import { getAgentExecutionService } from "@/lib/services/agent-execution-service";

// This endpoint is meant to be called by Azure Functions timer trigger
// or any external scheduler to process due check-ins

export async function POST(request: NextRequest) {
  try {
    // Optional: Verify this is coming from Azure Functions
    const authHeader = request.headers.get("x-functions-key");
    // In production, you'd validate this against a secret

    console.log("[Scheduler] Processing due check-ins");

    const dueCheckIns = await getDueCheckIns();

    if (dueCheckIns.length === 0) {
      return NextResponse.json({
        success: true,
        processed: 0,
        message: "No due check-ins",
      });
    }

    const results = [];
    const agentService = getAgentExecutionService();

    for (const checkIn of dueCheckIns) {
      try {
        // Mark as triggered to prevent duplicate processing
        await markCheckInTriggered(checkIn.userId, checkIn.scheduledTime);

        console.log(`[Scheduler] Executing check-in for user: ${checkIn.userId}`);

        const result = await agentService.executeCheckIn(checkIn.userId);

        await markCheckInCompleted(checkIn.userId, checkIn.scheduledTime);

        results.push({
          userId: checkIn.userId,
          success: result.success,
          suggestedNextCheckIn: result.suggestedNextCheckIn?.toISOString(),
        });
      } catch (error) {
        console.error(
          `[Scheduler] Error processing check-in for ${checkIn.userId}:`,
          error
        );
        results.push({
          userId: checkIn.userId,
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }

    return NextResponse.json({
      success: true,
      processed: results.length,
      results,
    });
  } catch (error) {
    console.error("[Scheduler] Error processing check-ins:", error);
    return NextResponse.json(
      { error: "Failed to process check-ins" },
      { status: 500 }
    );
  }
}
