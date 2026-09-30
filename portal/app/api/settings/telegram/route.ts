/**
 * Telegram Settings API
 *
 * Manage Telegram configuration (default recipient chat ID for notifications).
 */

import { getSetting, setSetting, deleteSetting } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const SETTING_KEY = "telegram_config";

interface TelegramConfigSetting {
  /** Default chat ID for outbound notifications (numeric Telegram chat ID) */
  defaultRecipient?: string;
}

export async function GET() {
  const config = await getSetting<TelegramConfigSetting>(SETTING_KEY);
  return NextResponse.json({ config });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as TelegramConfigSetting;

  await setSetting(SETTING_KEY, body);
  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const deleted = await deleteSetting(SETTING_KEY);
  return NextResponse.json({ success: true, deleted });
}
