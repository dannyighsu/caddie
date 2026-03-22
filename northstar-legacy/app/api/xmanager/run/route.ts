import { NextRequest, NextResponse } from "next/server";
import { getDefaultSlackChannel } from "@/lib/db/settings-repository";
import { getXManagerExecutionService } from "@/lib/services/xmanager-execution-service";
import { getMessagingService } from "@/lib/services/messaging-service";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const userId = body.userId || "default";

  console.log(`[API] Starting X Manager run for user: ${userId}`);

  const xManagerService = getXManagerExecutionService();
  const defaultSlackChannel = await getDefaultSlackChannel();

  let result;
  try {
    result = await xManagerService.executeRun(userId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    console.error("[API] X Manager run error:", errorMessage);

    // Post failure to Slack (Invariant 8: no silent failures)
    if (defaultSlackChannel) {
      const messagingService = getMessagingService();
      await messagingService.sendToSlackWithIdentity(
        `:warning: *X Manager run failed*: ${errorMessage}`,
        defaultSlackChannel
      );
    }

    return NextResponse.json(
      { success: false, error: errorMessage },
      { status: 500 }
    );
  }

  if (!result.success) {
    // Post failure to Slack (Invariant 8: no silent failures)
    if (defaultSlackChannel) {
      const messagingService = getMessagingService();
      await messagingService.sendToSlackWithIdentity(
        `:warning: *X Manager run failed*: ${result.error ?? "Unknown error"}`,
        defaultSlackChannel
      );
    }

    const statusCode = result.error?.includes("already in progress") ? 409 : 500;
    return NextResponse.json(
      { success: false, error: result.error },
      { status: statusCode }
    );
  }

  // Send digest to Slack
  if (defaultSlackChannel && result.slackMessage) {
    const messagingService = getMessagingService();
    await messagingService.sendToSlackWithIdentity(
      result.slackMessage,
      defaultSlackChannel
    );
    console.log(`[API] Sent X Manager report to Slack`);
  } else if (!defaultSlackChannel) {
    console.warn("[API] No default Slack channel configured - skipping Slack message");
  }

  return NextResponse.json({
    success: true,
    slackMessage: result.slackMessage,
    nextRunTime: result.nextRunTime?.toISOString(),
    summary: {
      opportunitiesFound: result.runRecord?.opportunitiesFound.length || 0,
      performanceMetrics: result.runRecord?.performanceMetrics.length || 0,
    },
  });
}
