/**
 * Slack Settings API
 *
 * Manage the default Slack channel for agent notifications.
 */

import { getSetting, setSetting, deleteSetting } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const SETTING_KEY = "default_slack_channel";

interface SlackChannelSetting {
  channelId: string;
  channelName?: string;
}

export async function GET() {
  const channel = await getSetting<SlackChannelSetting>(SETTING_KEY);
  return NextResponse.json({ channel });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { channelId, channelName } = body as SlackChannelSetting;

  if (!channelId) {
    return NextResponse.json({ error: "channelId is required" }, { status: 400 });
  }

  await setSetting(SETTING_KEY, { channelId, channelName });
  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const deleted = await deleteSetting(SETTING_KEY);
  return NextResponse.json({ success: true, deleted });
}
