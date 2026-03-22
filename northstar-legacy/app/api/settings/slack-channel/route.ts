import { NextRequest, NextResponse } from "next/server";
import {
  getDefaultSlackChannel,
  setDefaultSlackChannel,
  clearDefaultSlackChannel,
  SlackChannelIdentity,
} from "@/lib/db/settings-repository";

export async function GET() {
  try {
    const channel = await getDefaultSlackChannel();
    return NextResponse.json({ channel });
  } catch (error) {
    console.error("[Settings] Error getting default Slack channel:", error);
    return NextResponse.json(
      { error: "Failed to get default Slack channel" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { appId, channelId, teamId } = body as Partial<SlackChannelIdentity>;

    if (!appId || !channelId || !teamId) {
      return NextResponse.json(
        { error: "appId, channelId, and teamId are required" },
        { status: 400 }
      );
    }

    await setDefaultSlackChannel({ appId, channelId, teamId });

    console.log(
      `[Settings] Set default Slack channel: team=${teamId}, channel=${channelId}, app=${appId}`
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Settings] Error setting default Slack channel:", error);
    return NextResponse.json(
      { error: "Failed to set default Slack channel" },
      { status: 500 }
    );
  }
}

export async function DELETE() {
  try {
    const deleted = await clearDefaultSlackChannel();
    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    console.error("[Settings] Error clearing default Slack channel:", error);
    return NextResponse.json(
      { error: "Failed to clear default Slack channel" },
      { status: 500 }
    );
  }
}
