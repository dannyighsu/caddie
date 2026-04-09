/**
 * Resend Inbound Email Webhook
 *
 * Receives email.received events from Resend.
 * Fetches full email content via Resend API and processes it.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyWebhook } from "@/lib/email";
import { handleEmailMessage } from "@/lib/email-handler";

interface ResendEmailEvent {
  type: "email.received";
  created_at: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
  };
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  // Verify webhook signature
  const event = verifyWebhook(
    rawBody,
    request.headers,
  ) as ResendEmailEvent | null;

  if (!event) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  if (event.type !== "email.received") {
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  const { email_id, from, subject } = event.data;

  // Process async — return 200 quickly
  handleEmailMessage(email_id, from, subject).catch((err) => {
    console.error("[Email Webhook] Handler error:", err);
  });

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
