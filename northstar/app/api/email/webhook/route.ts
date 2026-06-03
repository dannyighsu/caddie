/**
 * AgentMail Inbound Email Webhook
 *
 * Receives `message.received` events from AgentMail. The payload includes
 * the full message — no follow-up fetch is needed.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyWebhook } from "@/lib/email";
import { handleEmailMessage } from "@/lib/email-handler";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  const event = verifyWebhook(rawBody, request.headers);
  if (!event) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (event.event !== "message.received") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  // Process async — return 200 quickly so AgentMail doesn't retry.
  handleEmailMessage(event.message).catch((err) => {
    console.error("[Email Webhook] Handler error:", err);
  });

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
