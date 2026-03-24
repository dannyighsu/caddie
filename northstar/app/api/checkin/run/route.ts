/**
 * Check-In Gateway Route
 *
 * Launches the check-in workflow, posts the result to Slack,
 * and schedules the next check-in.
 */

import { getLauncher } from "@/lib/harness";
import {
  createConversation,
  getConversation,
  appendMessages,
  updateSessionId,
  type Message,
} from "@/lib/db";
import { isRunActive, setActiveRun, clearActiveRun, scheduleRun } from "@/lib/redis";
import { sendMessage, isSlackConfigured } from "@/lib/slack";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const {
    conversationId,
    prompt = "Conduct a check-in.",
    slackChannel,
  } = body as {
    conversationId?: string;
    prompt?: string;
    slackChannel?: string;
  };

  // Prevent concurrent runs
  if (await isRunActive("checkin")) {
    return NextResponse.json(
      { error: "A check-in is already in progress" },
      { status: 409 }
    );
  }

  await setActiveRun("checkin");

  try {
    // Resolve or create conversation
    let conversation;
    let sessionId: string | undefined;

    if (conversationId) {
      conversation = await getConversation(conversationId);
      if (!conversation) {
        return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      }
      sessionId = conversation.session_id ?? undefined;
    } else {
      conversation = await createConversation("checkin", "Check-in");
    }

    const currentTime = new Date().toLocaleString("en-US", {
      timeZone: "America/Los_Angeles",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: "checkin",
      prompt,
      sessionId,
      context: { currentTime },
    });

    // Record messages
    const now = new Date().toISOString();
    const newMessages: Message[] = [
      { role: "user", content: prompt, timestamp: now },
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

    // Post to Slack if configured
    if (slackChannel && isSlackConfigured() && result.rawText) {
      try {
        await sendMessage(slackChannel, result.rawText);
      } catch (err) {
        console.error("[Check-in] Failed to post to Slack:", err);
      }
    }

    // Schedule next check-in (default 2 hours)
    const nextCheckInMinutes = result.output?.nextCheckInTime as number | undefined ?? 120;
    const nextTime = new Date(Date.now() + nextCheckInMinutes * 60 * 1000);
    try {
      await scheduleRun("checkin", nextTime);
    } catch (err) {
      console.error("[Check-in] Failed to schedule next run:", err);
    }

    return NextResponse.json({
      success: result.success,
      conversationId: conversation.id,
      sessionId: result.sessionId,
      rawText: result.rawText,
      output: result.output,
      nextCheckIn: nextTime.toISOString(),
      error: result.error,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Check-in] Execution failed:", error);
    return NextResponse.json({ success: false, error }, { status: 500 });
  } finally {
    await clearActiveRun("checkin");
  }
}
