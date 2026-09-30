import { listAgents } from "@/lib/harness";
import { NextResponse } from "next/server";

export async function GET() {
  const agents = await listAgents();
  return NextResponse.json(agents);
}
