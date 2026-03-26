/**
 * Slack Events API Webhook
 *
 * Receives inbound Slack messages, routes to the right agent, and replies in thread.
 *
 * Threading model:
 * - event.ts = message timestamp (unique ID of this message)
 * - event.thread_ts = timestamp of the first message in the thread (present only for replies)
 * - If thread_ts is absent, this is a new top-level message (start of a new conversation)
 * - If thread_ts is present, this is a reply in an existing thread (continue conversation)
 *
 * Routing:
 * - New thread: classify message → pick agent → send routing confirmation → run agent
 * - Existing thread: look up conversation → use same agent → run with session resumption
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
import { replyInThread } from "@/lib/slack";
import { classifyMessage } from "@/lib/classifier";
import { NextRequest, NextResponse } from "next/server";

// --- Slack signature verification ---

function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string
): boolean {
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  if (!signingSecret) {
    console.warn("[Slack Webhook] SLACK_SIGNING_SECRET not set, skipping verification");
    return true;
  }

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

  if (!verifySlackSignature(rawBody, timestamp, signature)) {
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody);

  // Handle URL verification challenge
  if (payload.type === "url_verification") {
    return NextResponse.json({ challenge: payload.challenge });
  }

  if (payload.type !== "event_callback") {
    return NextResponse.json({ ok: true });
  }

  const event = payload.event;

  if (!event || (event.type !== "message" && event.type !== "app_mention")) {
    return NextResponse.json({ ok: true });
  }

  // Skip bot messages, message edits, and subtypes
  if (event.bot_id || event.subtype) {
    return NextResponse.json({ ok: true });
  }

  const userText = event.text as string;
  const channel = event.channel as string;
  const ts = event.ts as string;
  const threadTs = event.thread_ts as string | undefined;

  // Strip bot mention from text
  const cleanText = userText.replace(/<@[A-Z0-9]+>/g, "").trim();
  if (!cleanText) {
    return NextResponse.json({ ok: true });
  }

  // Determine if this is a new thread or a reply
  const isNewThread = !threadTs;
  // For new threads, the thread_ts for replies will be this message's ts
  // For replies, use the existing thread_ts
  const conversationThreadTs = threadTs ?? ts;
  const externalId = `slack:${channel}:${conversationThreadTs}`;

  try {
    let conversation = await getConversationByExternalId(externalId);
    let sessionId: string | undefined;

    if (conversation) {
      // Existing thread — continue with the same agent
      sessionId = conversation.session_id ?? undefined;
    } else {
      // New thread — classify and route
      const classification = await classifyMessage(cleanText);
      console.log(
        `[Slack Webhook] Classified as: ${classification.agentId} (${classification.confidence})`
      );

      const title = cleanText.length > 80
        ? cleanText.substring(0, 80) + "..."
        : cleanText;
      conversation = await createConversation(
        classification.agentId,
        title,
        externalId
      );

      // Send routing confirmation as first reply in the thread
      await replyInThread(
        channel,
        conversationThreadTs,
        `_Routed to ${classification.agentName}_`
      );
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

    // Reply in thread
    if (result.rawText) {
      await replyInThread(channel, conversationThreadTs, result.rawText);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Slack Webhook] Error:", error);

    try {
      await replyInThread(
        channel,
        conversationThreadTs,
        `Sorry, something went wrong: ${error}`
      );
    } catch {
      // Best effort
    }

    return NextResponse.json({ ok: true });
  }
}
