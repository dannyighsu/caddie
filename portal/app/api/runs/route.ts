/**
 * Runs API — /api/runs
 *
 * Lists job-run ledger entries for the portal Runs view. Defaults to failed
 * runs (the replay candidates); pass ?status=all or ?status=active to widen.
 */

import { listRuns, type JobRun, type RunStatusFilter } from "@/lib/job-ledger";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * A short, human hint of what a live replay of this run would deliver, so the
 * portal can warn before re-sending. Derived from the replay envelope.
 */
function describeDelivery(env: JobRun["envelope"]): string {
  switch (env.source) {
    case "inbound":
      return env.params.replyTarget
        ? `may re-reply on ${env.params.replyTarget.channel}`
        : "may re-reply on its channel";
    case "portal":
      return "console only (no external delivery)";
    case "scheduler":
    case "trigger":
      return env.job.action === "notify"
        ? `re-sends a ${env.job.notificationChannel ?? "slack"} notification`
        : "may send email / notifications";
  }
}

export async function GET(request: NextRequest) {
  const statusParam = request.nextUrl.searchParams.get("status") ?? "failed";
  const status: RunStatusFilter = ["all", "failed", "active"].includes(statusParam)
    ? (statusParam as RunStatusFilter)
    : "failed";
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Number(limitParam) || 50, 200) : 50;

  try {
    const runs = await listRuns({ status, limit });
    // Drop the (potentially large) envelope from the list payload — the UI only
    // needs the summary fields plus a delivery hint; replay reads the envelope
    // server-side by id.
    const summaries = runs.map(({ envelope, ...rest }) => ({
      ...rest,
      deliversTo: describeDelivery(envelope),
    }));
    return NextResponse.json(summaries);
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error }, { status: 500 });
  }
}
