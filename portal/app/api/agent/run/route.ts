import { runPortalAgent } from "@/lib/portal-run";
import { NextRequest, NextResponse } from "next/server";
import { parsePortalOwner } from "@/lib/identity";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { prompt, conversationId, context } = body as {
    prompt?: string;
    conversationId?: string;
    context?: Record<string, string>;
  };

  if (!prompt) {
    return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  }

  // The agent page is the owner console (network-gated), so runs execute as
  // the selected team owner.
  const portalOwner = parsePortalOwner(request.cookies.get("portal_owner")?.value);

  try {
    const result = await runPortalAgent({
      prompt,
      portalOwner,
      context,
      conversationId,
    });

    return NextResponse.json({
      success: result.success,
      conversationId: result.conversationId,
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
