/**
 * WhatsApp Webhook API
 *
 * Handles the Meta webhook verification handshake (GET) and
 * incoming message events (POST).
 *
 * Register this URL in the Meta App Dashboard under Webhooks:
 *   https://<your-domain>/api/webhooks/whatsapp
 *
 * Subscribe to the "messages" field for the WhatsApp Business Account.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getVerifyToken,
  verifyWebhookSignature,
  extractMessages,
  isWhatsAppConfigured,
  type WhatsAppWebhookPayload,
} from "@/lib/whatsapp";
import { handleWhatsAppMessage } from "@/lib/whatsapp-handler";

/**
 * GET — Meta webhook verification handshake.
 *
 * Meta sends: ?hub.mode=subscribe&hub.verify_token=<token>&hub.challenge=<challenge>
 * We respond with the challenge value if the token matches.
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode = searchParams.get("hub.mode");
  const token = searchParams.get("hub.verify_token");
  const challenge = searchParams.get("hub.challenge");

  if (mode === "subscribe" && token === getVerifyToken()) {
    console.log("[WhatsApp Webhook] Verification successful");
    return new NextResponse(challenge, { status: 200 });
  }

  console.warn("[WhatsApp Webhook] Verification failed");
  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/**
 * POST — Incoming webhook events from Meta.
 *
 * Must always return 200 quickly to avoid Meta retrying.
 * Message processing happens in the background.
 */
export async function POST(request: NextRequest) {
  if (!isWhatsAppConfigured()) {
    return NextResponse.json({ error: "WhatsApp not configured" }, { status: 503 });
  }

  // Verify signature
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256") ?? "";
  if (!verifyWebhookSignature(rawBody, signature)) {
    console.warn("[WhatsApp Webhook] Invalid signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: WhatsAppWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (payload.object !== "whatsapp_business_account") {
    return NextResponse.json({ error: "Not a WhatsApp event" }, { status: 400 });
  }

  // Extract messages and process each one
  const messages = extractMessages(payload);

  // Process messages in the background so we return 200 quickly
  for (const { message, senderName } of messages) {
    // Fire and forget — errors are logged inside handleWhatsAppMessage
    handleWhatsAppMessage(message, senderName).catch((err) => {
      console.error("[WhatsApp Webhook] Background processing error:", err);
    });
  }

  // Always return 200 to Meta to acknowledge receipt
  return NextResponse.json({ status: "ok" });
}
