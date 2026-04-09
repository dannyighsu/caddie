/**
 * WhatsApp Cloud API Webhook
 *
 * GET  — Meta verification challenge (called once during webhook setup)
 * POST — Inbound messages from WhatsApp users
 */

import { NextRequest, NextResponse } from "next/server";
import {
  isCloudAPIConfigured,
  getVerifyToken,
  verifyWebhookSignature,
  extractMessages,
  markAsRead,
  type WebhookPayload,
} from "@/lib/whatsapp-api";
import { handleCloudAPIMessage } from "@/lib/whatsapp-api-handler";

/**
 * Webhook verification (Meta sends this once during setup).
 * Must return the hub.challenge value if the verify token matches.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");

  if (mode === "subscribe" && token === getVerifyToken()) {
    console.log("[WhatsApp API] Webhook verified");
    return new NextResponse(challenge, { status: 200 });
  }

  return NextResponse.json({ error: "Verification failed" }, { status: 403 });
}

/**
 * Inbound message webhook.
 * Meta sends message events here as POST requests.
 */
export async function POST(request: NextRequest) {
  if (!isCloudAPIConfigured()) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  // Verify signature
  const signature = request.headers.get("x-hub-signature-256");
  const rawBody = Buffer.from(await request.arrayBuffer());

  const valid = await verifyWebhookSignature(rawBody, signature);
  if (!valid) {
    console.warn("[WhatsApp API] Invalid webhook signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody.toString()) as WebhookPayload;

  // Must always return 200 quickly to Meta, process async
  if (payload.object !== "whatsapp_business_account") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const messages = extractMessages(payload);

  // Process messages in background (don't block the 200 response)
  for (const msg of messages) {
    // Fire and forget — errors are caught inside the handler
    handleCloudAPIMessage(msg).then(() => {
      markAsRead(msg.messageId).catch(() => {});
    }).catch((err) => {
      console.error("[WhatsApp API] Handler error:", err);
    });
  }

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
