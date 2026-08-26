import { getAgent } from "@/lib/harness";
import { DEFAULT_MAX_TURNS } from "@agints/harness";
import { NextResponse } from "next/server";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const agent = await getAgent(id);

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Resolve the turn ceiling here rather than in the browser — the default
  // lives in the harness, which can't be imported into a client component.
  return NextResponse.json({ ...agent, maxTurns: agent.maxTurns ?? DEFAULT_MAX_TURNS });
}
