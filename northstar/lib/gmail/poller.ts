/**
 * Gmail inbound poller.
 *
 * Replaces the AgentMail webhook. Uses the "UNREAD label as the queue" pattern
 * (from openclaw-gmail): each tick lists INBOX+UNREAD, dispatches each message to
 * the shared handler, and only marks it read on success — so a failed dispatch
 * simply stays UNREAD and retries next tick. No Pub/Sub, no historyId cursor.
 *
 * Started once from instrumentation.ts, alongside the scheduler and Slack.
 */

import { isGmailConfigured } from "./client";
import { listUnreadInboxIds, getInboundMessage, markMessageRead } from "./transport";
import { receivedFromGmail } from "../email";
import { handleReceivedEmail } from "../email-handler";

const POLL_INTERVAL_MS = process.env.GMAIL_POLL_INTERVAL_MS
  ? parseInt(process.env.GMAIL_POLL_INTERVAL_MS, 10)
  : 60_000;

let running = false;
let syncing = false;

// Within-process guard against re-dispatching a message before Gmail's UNREAD
// label change propagates (mirrors the plugin's dispatchedMessageIds). Cleared
// hourly so it can't grow unbounded.
const dispatched = new Set<string>();
setInterval(() => dispatched.clear(), 60 * 60 * 1000).unref();

/** Start the inbound polling loop. Safe to call multiple times. */
export function startGmailPoller(): void {
  if (running) return;
  if (!isGmailConfigured()) {
    console.warn("[Gmail Poller] Not configured (missing Google creds or token file) — inbound polling disabled");
    return;
  }
  running = true;
  console.log(`[Gmail Poller] Started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  setInterval(() => void pollOnce(), POLL_INTERVAL_MS);
  void pollOnce(); // kick an immediate first poll
}

async function pollOnce(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const ids = await listUnreadInboxIds();
    for (const id of ids) {
      if (dispatched.has(id)) continue;

      let inbound;
      try {
        inbound = await getInboundMessage(id);
      } catch (err) {
        console.error(`[Gmail Poller] Failed to fetch message ${id}:`, err);
        continue;
      }
      if (!inbound) continue;

      dispatched.add(id);
      try {
        await handleReceivedEmail(receivedFromGmail(inbound));
        // De-queue this message and only this message. Clearing UNREAD across
        // the whole thread would also de-queue any sibling that arrived while
        // this dispatch was in flight, losing it with no run and no error.
        // Only after successful dispatch — a throw leaves it UNREAD for retry.
        await markMessageRead(inbound.id);
      } catch (err) {
        console.error(`[Gmail Poller] Dispatch failed for ${id}, leaving UNREAD:`, err);
        dispatched.delete(id);
      }
    }
  } catch (err) {
    console.error("[Gmail Poller] Poll error:", err);
  } finally {
    syncing = false;
  }
}
