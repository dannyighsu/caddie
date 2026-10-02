import { getAgentConfig } from "@/lib/harness";
import { agentName } from "@/lib/agent-name";
import { DEFAULT_MAX_TURNS } from "@ignis/harness";
import { NextResponse } from "next/server";

export async function GET() {
  const agent = await getAgentConfig();
  // Resolve the turn ceiling here rather than in the browser — the default
  // lives in the harness, which can't be imported into a client component.
  return NextResponse.json({
    ...agent,
    name: agentName(),
    maxTurns: agent.maxTurns ?? DEFAULT_MAX_TURNS,
  });
}
