import { getLauncher, getAgent } from "@/lib/harness";
import {
  createConversation,
  getConversation,
  appendMessages,
  updateSessionId,
  type Message,
} from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { portalIdentity, toRunIdentity, parsePortalOwner } from "@/lib/identity";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = await getAgent(id);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const { prompt, conversationId, context } = body as {
    prompt?: string;
    conversationId?: string;
    context?: Record<string, string>;
  };

  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  const resolvedContext: Record<string, string> = {
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
    ...context,
  };

  try {
    let conversation;
    let sessionId: string | undefined;

    if (conversationId) {
      conversation = await getConversation(conversationId);
      if (!conversation) {
        return NextResponse.json(
          { error: "Conversation not found" },
          { status: 404 }
        );
      }
      sessionId = conversation.session_id ?? undefined;
    } else {
      const title = prompt.length > 80 ? prompt.substring(0, 80) + "..." : prompt;
      conversation = await createConversation(id, title);
    }

    // The agent page is the owner console (network-gated), so runs execute as
    // the selected household owner.
    const portalOwner = parsePortalOwner(request.cookies.get("portal_owner")?.value);

    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: id,
      identity: toRunIdentity(portalIdentity(portalOwner)),
      prompt,
      sessionId,
      context: resolvedContext,
    });

    const now = new Date().toISOString();
    const newMessages: Message[] = [
      {
        role: "user",
        content: prompt,
        timestamp: now,
        sender: { kind: "authenticated", userId: portalOwner },
      },
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

    return NextResponse.json({
      success: result.success,
      conversationId: conversation.id,
      sessionId: result.sessionId,
      rawText: result.rawText,
      output: result.output,
      error: result.error,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ success: false, error }, { status: 500 });
  }
}
