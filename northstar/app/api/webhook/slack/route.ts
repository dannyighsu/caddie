/**
 * Slack Events API Webhook
 *
 * Receives inbound Slack messages (app_mention, message in DM),
 * looks up or creates a conversation keyed by channel+thread,
 * launches the agent with session resumption, and replies in thread.
 */

import { createHmac, timingSafeEqual } from "crypto";
import { getLauncher } from "@/lib/harness";
import {
  createConversation,
  getConversationByExternalId,
  appendMessages,
  updateSessionId,
  type Message,
} from "@/lib/db";
import { replyInThread, sendMessage } from "@/lib/slack";
import { NextRequest, NextResponse } from "next/server";

// Default agent for Slack conversations
const DEFAULT_AGENT_ID = "checkin";

// --- Slack signature verification ---

function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn("[Slack Webhook] SLACK_SIGNING_SECRET not set, skipping verification");
    return true; // Allow in development
  }

  // Reject requests older than 5 minutes
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 300;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    return false;
  }

  const sigBaseString = `v0:${timestamp}:${body}`;
  const mySignature = "v0=" + createHmac("sha256", signingSecret)
    .update(sigBaseString)
    .digest("hex");

  return timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(signature)
  );
}

// --- Route handler ---

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const timestamp = request.headers.get("x-slack-request-timestamp") ?? "";
  const signature = request.headers.get("x-slack-signature") ?? "";

  // Verify signature
  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);

  // Handle URL verification challenge
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  // Handle event callbacks
  if (payload.type !== "event_callback") {
    return NextResponse.json({ ok: true });
  }

  const event = payload.event;

  // Only handle messages and app mentions
  if (!event || (event.type !== "message" && event.type !== "app_mention")) {
    return NextResponse.json({ ok: true });
  }

  // Skip bot messages, message edits, and subtypes
  if (event.bot_id || event.subtype) {
    return NextResponse.json({ ok: true });
  }

  const userText = event.text as string;
  const channel = event.channel as string;
  const threadTs = (event.thread_ts ?? event.ts) as string;

  // Strip bot mention from text (e.g., "<@U12345> check in" -> "check in")
  const cleanText = userText.replace(/<@[A-Z0-9]+>/g, "").trim();

  if (!cleanText) {
    return NextResponse.json({ ok: true });
  }

  // Use channel+thread as the external conversation ID
  const externalId = `slack:${channel}:${threadTs}`;

  try {
    // Look up or create conversation
    let conversation = await getConversationByExternalId(externalId);
    let sessionId: string | undefined;

    if (conversation) {
      sessionId = conversation.session_id ?? undefined;
    } else {
      const title = cleanText.length > 80 ? cleanText.substring(0, 80) + "..." : cleanText;
      conversation = await createConversation(DEFAULT_AGENT_ID, title, externalId);
    }

    // Launch agent
    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: conversation.agent_id,
      prompt: cleanText,
      sessionId,
      context: {
        currentTime: new Date().toLocaleString("en-US", {
          timeZone: "America/Los_Angeles",
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        }),
      },
    });

    // Record messages
    const now = new Date().toISOString();
    const newMessages: Message[] = [
      { role: "user", content: cleanText, timestamp: now },
    ];
    if (result.rawText) {
      newMessages.push({
        role: "assistant",
        content: result.rawText,
        timestamp: new Date().toISOString(),
      });
    }
    await appendMessages(conversation.id, newMessages);

    if (result.sessionId) {
      await updateSessionId(conversation.id, result.sessionId);
    }

    // Reply in Slack thread
    if (result.rawText) {
      if (threadTs === event.ts) {
        // First message in thread — reply creates the thread
        await sendMessage(channel, result.rawText);
      } else {
        await replyInThread(channel, threadTs, result.rawText);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Slack Webhook] Error:", error);

    // Try to notify the user of the error
    try {
      await replyInThread(
        channel,
        threadTs,
        `Sorry, something went wrong: ${error}`
      );
    } catch {
      // Best effort
    }

    return NextResponse.json({ ok: true }); // Always 200 to Slack to prevent retries
  }
}
