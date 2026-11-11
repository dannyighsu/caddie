import { listConversations } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const limit = parseInt(
    request.nextUrl.searchParams.get("limit") ?? "20",
    10
  );

  const conversations = await listConversations(limit);
  return NextResponse.json(conversations);
}
