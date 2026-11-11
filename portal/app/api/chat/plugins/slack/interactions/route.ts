/**
 * Slack Interactivity Request URL
 *
 * POST — Block Kit interactions (form submits, button clicks).
 *
 * Slack calls this only while the app has Socket Mode off. With it on, the same
 * payloads arrive over the socket instead (see startSocketMode in lib/slack).
 */

import { NextRequest, NextResponse } from "next/server";
import { isSlackConfigured } from "@/lib/slack";
import { handleSlackInteraction } from "@/lib/slack-handler";
import { parseInteractionBody, verifySlackSignature } from "@/lib/slack-interactions";

export async function POST(request: NextRequest) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!isSlackConfigured() || !secret) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  const verified = verifySlackSignature({
    secret,
    timestamp: request.headers.get("x-slack-request-timestamp"),
    signature: request.headers.get("x-slack-signature"),
    rawBody,
  });
  if (!verified) {
    console.warn("[Slack] Invalid interaction signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = parseInteractionBody(rawBody);
  if (!payload) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  // Process in background — Slack expects a 200 within 3 seconds
  handleSlackInteraction(payload).catch((err) => {
    console.error("[Slack] Interaction handler error:", err);
  });

  return new NextResponse(null, { status: 200 });
}
