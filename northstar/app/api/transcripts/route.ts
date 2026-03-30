import { listTranscripts } from "@/lib/transcripts";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const agentId = request.nextUrl.searchParams.get("agentId") ?? "buri";
  const transcripts = await listTranscripts(agentId);
  return NextResponse.json(transcripts);
}
