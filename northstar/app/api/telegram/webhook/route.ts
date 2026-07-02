/**
 * Telegram Bot Webhook
 *
 * POST — Inbound updates from Telegram (messages, edits, etc.)
 *
 * Register the webhook URL once via:
 *   curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-domain.com/api/telegram/webhook&secret_token=<SECRET>"
 */

import { NextRequest, NextResponse } from "next/server";
import {
  isTelegramConfigured,
  verifyWebhookSecret,
  isChatAllowed,
  type TelegramUpdate,
} from "@/lib/telegram";
import { handleTelegramMessage } from "@/lib/telegram-handler";

export async function POST(request: NextRequest) {
  if (!isTelegramConfigured()) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  // Verify the secret token if configured
  const secretHeader = request.headers.get("x-telegram-bot-api-secret-token");
  if (!verifyWebhookSecret(secretHeader)) {
    console.warn("[Telegram] Invalid webhook secret");
    return NextResponse.json({ error: "Invalid secret" }, { status: 401 });
  }

  const update = (await request.json()) as TelegramUpdate;

  // We handle regular messages and edits. Ignore channel posts and other update types.
  const msg = update.message ?? update.edited_message;
  if (!msg) {
    console.log(
      `[Telegram] Skipping update: not a message or edited_message (keys=${Object.keys(update).join(",")})`,
    );
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  // Chat allowlist — ignore messages from unauthorized chats
  if (!isChatAllowed(msg.chat.id)) {
    console.log(`[Telegram] Ignoring message from chat ${msg.chat.id} (not in TELEGRAM_ALLOWED_CHATS)`);
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  // Process in background — Telegram expects a 200 quickly
  handleTelegramMessage(msg).catch((err) => {
    console.error("[Telegram] Handler error:", err);
  });

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
