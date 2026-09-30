/**
 * Gmail inbound poller.
 *
 * Replaces the AgentMail webhook. Uses the "UNREAD label as the queue" pattern
 * (from openclaw-gmail): each tick lists INBOX+UNREAD, dispatches each message to
 * the shared handler, and only marks it read on success — so a failed dispatch
 * simply stays UNREAD and retries next tick. No Pub/Sub, no historyId cursor.
 *
 * UNREAD is only the queue, not the record of what was handled: a message can
 * turn UNREAD again (someone marks the thread unread, a mark-read call fails),
 * and a second poller process sees the same queue. So each message is claimed
 * in Redis before dispatch, and a claimed message is only marked read, never
 * redelivered. Messages are dispatched oldest first, so a backlog on one thread
 * reaches the agent in the order it was sent.
 *
 * Started once from instrumentation.ts, alongside the scheduler and Slack.
 */

import { isGmailConfigured } from "./client";
import { listUnreadInboxIds, getInboundMessage, markMessageRead, type GmailInbound } from "./transport";
import { claimInboundMessage, releaseInboundMessage } from "../redis";
import { receivedFromGmail } from "../email";
import { handleReceivedEmail } from "../email-handler";

const POLL_INTERVAL_MS = process.env.GMAIL_POLL_INTERVAL_MS
  ? parseInt(process.env.GMAIL_POLL_INTERVAL_MS, 10)
  : 60_000;

let running = false;
let syncing = false;

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

    // Gmail lists newest first; fetch the batch, then dispatch oldest first.
    const inbound: GmailInbound[] = [];
    for (const id of ids) {
      try {
        const msg = await getInboundMessage(id);
        if (msg) inbound.push(msg);
      } catch (err) {
        console.error(`[Gmail Poller] Failed to fetch message ${id}:`, err);
      }
    }
    inbound.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));

    for (const msg of inbound) {
      if (!(await claimInboundMessage(msg.id))) {
        console.log(
          `[Gmail Poller] Skipping ${msg.id} (thread ${msg.threadId}): already handled, marking read`,
        );
        await markMessageRead(msg.id).catch((err) =>
          console.error(`[Gmail Poller] Failed to mark handled message ${msg.id} read:`, err),
        );
        continue;
      }

      try {
        await handleReceivedEmail(receivedFromGmail(msg));
      } catch (err) {
        console.error(`[Gmail Poller] Dispatch failed for ${msg.id}, leaving UNREAD:`, err);
        await releaseInboundMessage(msg.id);
        continue;
      }
      // De-queue this message and only this message. Clearing UNREAD across
      // the whole thread would also de-queue any sibling that arrived while
      // this dispatch was in flight, losing it with no run and no error. A
      // failure here is harmless: the claim stops a redelivery, and the next
      // tick retries the mark.
      await markMessageRead(msg.id).catch((err) =>
        console.error(`[Gmail Poller] Failed to mark ${msg.id} read:`, err),
      );
    }
  } catch (err) {
    console.error("[Gmail Poller] Poll error:", err);
  } finally {
    syncing = false;
  }
}
