/**
 * Linear Webhook
 *
 * POST: agent session events for the Caddie app (a mention, a delegation, a
 * follow-up message). Set this URL as the app's webhook in Linear with
 * "Agent session events" enabled; Settings → Linear shows the full URL.
 *
 * Linear gives a delivery 5 seconds before it retries, so the run starts in
 * the background and this returns at once.
 */

import { NextRequest, NextResponse } from "next/server";
import { loadLinearSettings } from "@/lib/linear";
import { isConfigured } from "@/lib/linear-settings";
import { isAgentSessionEvent, isFresh, verifySignature } from "@/lib/linear-webhook";
import { handleLinearAgentSessionEvent } from "@/lib/linear-handler";

/**
 * Deliveries already accepted, so a retry of one that was slow to answer
 * doesn't start a second run. Linear retries after a minute at the soonest,
 * and the freshness check rejects anything older, so a short memory suffices.
 */
const seen = new Map<string, number>();
const SEEN_TTL_MS = 10 * 60 * 1000;

function firstDelivery(id: string | null): boolean {
  if (!id) return true;
  const now = Date.now();
  for (const [key, at] of seen) if (now - at > SEEN_TTL_MS) seen.delete(key);
  if (seen.has(id)) return false;
  seen.set(id, now);
  return true;
}

export async function POST(request: NextRequest) {
  const settings = await loadLinearSettings();
  if (!isConfigured(settings) || !settings.installation) {
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const rawBody = await request.text();
  if (!verifySignature(rawBody, request.headers.get("linear-signature"), settings.webhookSecret)) {
    console.warn("[Linear] Invalid webhook signature");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { webhookTimestamp, organizationId, type } = (payload ?? {}) as Record<string, unknown>;
  if (!isFresh(webhookTimestamp, Date.now())) {
    console.warn("[Linear] Rejecting stale webhook delivery");
    return NextResponse.json({ error: "Stale delivery" }, { status: 401 });
  }

  if (organizationId !== settings.installation.organizationId) {
    console.warn(`[Linear] Ignoring delivery from another workspace (${String(organizationId)})`);
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  if (!isAgentSessionEvent(payload)) {
    console.log(`[Linear] Ignoring ${String(type)} event`);
    return NextResponse.json({ status: "ignored" }, { status: 200 });
  }

  if (!firstDelivery(request.headers.get("linear-delivery"))) {
    return NextResponse.json({ status: "duplicate" }, { status: 200 });
  }

  handleLinearAgentSessionEvent(payload).catch((err) => {
    console.error("[Linear] Handler error:", err);
  });

  return NextResponse.json({ status: "ok" }, { status: 200 });
}
