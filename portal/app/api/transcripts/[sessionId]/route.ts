import { readTranscript } from "@/lib/transcripts";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const agentId = request.nextUrl.searchParams.get("agentId") ?? "buri";

  try {
    const steps = await readTranscript(agentId, sessionId);
    return NextResponse.json({ sessionId, agentId, steps });
  } catch (err) {
    return NextResponse.json(
      { error: `Transcript not found: ${err instanceof Error ? err.message : err}` },
      { status: 404 }
    );
  }
}
