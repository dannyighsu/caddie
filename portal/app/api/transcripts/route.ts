import { listTranscripts } from "@/lib/transcripts";
import { NextResponse } from "next/server";

export async function GET() {
  const transcripts = await listTranscripts();
  return NextResponse.json(transcripts);
}
