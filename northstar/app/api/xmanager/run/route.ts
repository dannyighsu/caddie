import { NextRequest, NextResponse } from "next/server";
import { getDefaultSlackChannel } from "@/lib/db/settings-repository";
import { getXManagerExecutionService } from "@/lib/services/xmanager-execution-service";
import { getMessagingService } from "@/lib/services/messaging-service";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const userId = body.userId || "default";

    console.log(`[API] Starting X Manager run for user: ${userId}`);

    const xManagerService = getXManagerExecutionService();
    const result = await xManagerService.executeRun(userId);

    if (!result.success) {
      const statusCode = result.error?.includes("already in progress")
        ? 409
        : 500;
      return NextResponse.json(
        { success: false, error: result.error },
        { status: statusCode }
      );
    }

    // Send to Slack if configured
    const defaultSlackChannel = await getDefaultSlackChannel();
    if (defaultSlackChannel && result.slackMessage) {
      const messagingService = getMessagingService();
      await messagingService.sendToSlackWithIdentity(
        result.slackMessage,
        defaultSlackChannel
      );
      console.log(`[API] Sent X Manager report to Slack`);
    } else if (!defaultSlackChannel) {
      console.warn(
        "[API] No default Slack channel configured - skipping Slack message"
      );
    }

    return NextResponse.json({
      success: true,
      slackMessage: result.slackMessage,
      nextRunTime: result.nextRunTime?.toISOString(),
      summary: {
        repliesFound: result.runRecord?.runRecord.repliesFound.length || 0,
        opportunitiesFound:
          result.runRecord?.runRecord.opportunitiesFound.length || 0,
      },
    });
  } catch (error) {
    console.error("[API] X Manager run error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}
