import { readTranscript } from "@/lib/transcripts";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;

  try {
    const steps = await readTranscript(sessionId);
    return NextResponse.json({ sessionId, steps });
  } catch (err) {
    return NextResponse.json(
      { error: `Transcript not found: ${err instanceof Error ? err.message : err}` },
      { status: 404 }
    );
  }
}
