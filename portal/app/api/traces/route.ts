/**
 * Traces API
 *
 * Receives Claude Code hook events and forwards them to Langfuse.
 * Claude Code hooks POST here with tool call data during agent execution.
 *
 * The traceId is passed via the X-Trace-Id header or in the JSON body.
 */

import { processHookEvent } from "@/lib/tracing";
import { renewLeaseByTrace } from "@/lib/job-ledger";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const traceId = request.headers.get("x-trace-id");
  const body = await request.json().catch(() => ({}));

  const resolvedTraceId = traceId ?? (body.traceId as string);
  if (!resolvedTraceId) {
    return NextResponse.json(
      { error: "traceId required (X-Trace-Id header or body field)" },
      { status: 400 }
    );
  }

  // Hook activity means the run is alive — extend its ledger lease so a long
  // (but healthy) run isn't reaped as orphaned. Best-effort; never blocks.
  renewLeaseByTrace(resolvedTraceId).catch((err) =>
    console.error("[Traces] Lease renewal failed:", err instanceof Error ? err.message : err)
  );

  try {
    await processHookEvent(resolvedTraceId, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    console.error("[Traces] Failed to process hook event:", error);
    return NextResponse.json({ ok: true }); // Don't block Claude Code
  }
}
