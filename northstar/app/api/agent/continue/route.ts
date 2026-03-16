import { NextRequest, NextResponse } from "next/server";
import { getAgentExecutionService } from "@/lib/services/agent-execution-service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { userId = "default", message, previousMessages = [] } = body;

    if (!message) {
      return NextResponse.json(
        { error: "Message is required" },
        { status: 400 }
      );
    }

    console.log(`[API] Continuing conversation for user: ${userId}`);

    const agentService = getAgentExecutionService();
    const result = await agentService.continueConversation(
      userId,
      message,
      previousMessages
    );

    if (!result.success) {
      return NextResponse.json(
        { error: result.error || "Agent execution failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      messages: result.messages,
      suggestedNextCheckIn: result.suggestedNextCheckIn?.toISOString(),
    });
  } catch (error) {
    console.error("[API] Agent continue error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
