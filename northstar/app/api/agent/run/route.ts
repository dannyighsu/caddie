import { getDefaultSlackChannel } from "@/lib/db/settings-repository";
import { getAgentExecutionService } from "@/lib/services/agent-execution-service";
import { getMessagingService } from "@/lib/services/messaging-service";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const userId = body.userId || "default";
  const messages = body.messages || [];

  console.log(`[API] Starting agent run for user: ${userId}`);

  const agentService = getAgentExecutionService();
  const result = await agentService.executeCheckIn(userId, messages);

  // Send the agent's response to Slack if configured
  const defaultSlackChannel = await getDefaultSlackChannel();
  if (defaultSlackChannel && result.messages.length > 0) {
    const messagingService = getMessagingService();

    for (const msg of result.messages) {
      if (msg.role === "assistant" && msg.content) {
        await messagingService.sendToSlackWithIdentity(msg.content, defaultSlackChannel);
        console.log(`[API] Sent check-in message to Slack channel: ${defaultSlackChannel.channelId}`);
      }
    }
  } else if (!defaultSlackChannel) {
    console.warn("[API] No default Slack channel configured - check-in message not sent to Slack");
  }

  return NextResponse.json({
    success: true,
    messages: result.messages,
    suggestedNextCheckIn: result.suggestedNextCheckIn?.toISOString(),
  });
}
