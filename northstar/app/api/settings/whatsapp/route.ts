/**
 * WhatsApp Settings API
 *
 * Manage WhatsApp configuration (default recipient for notifications, bot name, etc.).
 */

import { getSetting, setSetting, deleteSetting } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

const SETTING_KEY = "whatsapp_config";

interface WhatsAppConfigSetting {
  /** Default recipient phone number for outbound notifications (international format, no +) */
  defaultRecipient?: string;
  /** Bot display name (used for @mention detection) */
  botName?: string;
}

export async function GET() {
  const config = await getSetting<WhatsAppConfigSetting>(SETTING_KEY);
  return NextResponse.json({ config });
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as WhatsAppConfigSetting;

  await setSetting(SETTING_KEY, body);
  return NextResponse.json({ success: true });
}

export async function DELETE() {
  const deleted = await deleteSetting(SETTING_KEY);
  return NextResponse.json({ success: true, deleted });
}
