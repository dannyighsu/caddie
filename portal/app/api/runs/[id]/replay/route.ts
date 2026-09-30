/**
 * Replay a job run — POST /api/runs/[id]/replay
 *
 * Re-runs a ledgered job from its stored envelope. This is a LIVE replay: the
 * agent runs and may re-deliver real messages/emails. The portal confirms with
 * the user before calling. Returns the new run's id.
 */

import { replayRun } from "@/lib/job-ledger";
import { NextRequest, NextResponse } from "next/server";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const result = await replayRun(id);
    return NextResponse.json({ ok: true, runId: result.runId });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error(`[Runs] Replay of ${id} failed:`, error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
