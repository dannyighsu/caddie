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
 * Every await here has a deadline and the loop reports on itself — see
 * ./poll-health for why, and for the outage that put it there. The short
 * version: a single await that never settled held the `syncing` latch up
 * forever, and because nothing threw, the only trace was a host log nobody
 * reads. "Retries next tick" is only true if there *is* a next tick, and
 * "stays UNREAD" is only safe if someone is told.
 *
 * Started once from instrumentation.ts, alongside the scheduler and Slack.
 */

import { isGmailConfigured } from "./client";
import { listUnreadInboxIds, getInboundMessage, markMessageRead, type GmailInbound } from "./transport";
import { claimInboundMessage, releaseInboundMessage } from "../redis";
import { receivedFromGmail } from "../email";
import { handleReceivedEmail } from "../email-handler";
import { sendNotification, DEFAULT_NOTIFICATION_CHANNEL } from "../notification-channels";
import { emailOwner } from "../owner-alert";
import { agentName } from "../agent-name";
import {
  withTimeout,
  initialStatus,
  isPollStuck,
  detectStall,
  shouldAlert,
  formatStallAlert,
  formatRecoveryAlert,
  describePollerHealth,
  errorSignature,
  FETCH_TIMEOUT_MS,
  DISPATCH_TIMEOUT_MS,
  MAX_DISPATCH_ATTEMPTS,
  type PollerStatus,
  type AlertState,
  type Stall,
} from "./poll-health";

const POLL_INTERVAL_MS = process.env.GMAIL_POLL_INTERVAL_MS
  ? parseInt(process.env.GMAIL_POLL_INTERVAL_MS, 10)
  : 60_000;

let running = false;
let syncing = false;
/**
 * Bumped when a poll is abandoned. A late finisher from an earlier generation
 * must not write to `status` or clear the latch held by the poll that replaced
 * it, so every write checks its generation first.
 */
let generation = 0;

let status: PollerStatus = initialStatus(false, Date.now());
let alertState: AlertState = {};
/** Consecutive dispatch failures per Gmail message id, for the quarantine rule. */
const attempts = new Map<string, number>();

/** A snapshot of inbound polling liveness, for the health check and the portal. */
export function pollerStatus(): PollerStatus {
  return { ...status };
}

/** Inbound polling as a health-check line. */
export function inboundHealth(): { status: "ok" | "error" | "skipped"; message: string } {
  return describePollerHealth(status, Date.now());
}

/** Start the inbound polling loop. Safe to call multiple times. */
export function startGmailPoller(): void {
  if (running) return;
  if (!isGmailConfigured()) {
    console.warn("[Gmail Poller] Not configured (missing Google creds or token file) — inbound polling disabled");
    status = initialStatus(false, Date.now());
    return;
  }
  running = true;
  status = initialStatus(true, Date.now());
  console.log(`[Gmail Poller] Started (polling every ${POLL_INTERVAL_MS / 1000}s)`);
  setInterval(() => void tick(), POLL_INTERVAL_MS);
  void tick(); // kick an immediate first poll
}

/**
 * One timer tick. Guards against overlapping polls, but — unlike the latch this
 * replaces — a poll that has stopped making progress is abandoned rather than
 * allowed to hold the guard forever.
 */
async function tick(): Promise<void> {
  const now = Date.now();
  if (syncing) {
    if (!isPollStuck(status, now)) return;
    // Every step inside a poll is bounded, so no progress past the bound means
    // something escaped its deadline. Leaving the latch up is the original bug.
    generation += 1;
    syncing = false;
    status.abandonedPolls += 1;
    const detail =
      `An inbound poll stopped making progress and was abandoned ` +
      `(no step completed since ${new Date(status.lastProgressAt ?? status.lastPollStartedAt ?? now).toISOString()}). ` +
      `Polling has been restarted.`;
    console.error(`[Gmail Poller] ${detail}`);
    await report({ kind: "poll-abandoned", detail, signature: "poll-abandoned" });
  }
  await pollOnce();
}

async function pollOnce(): Promise<void> {
  const myGen = generation;
  syncing = true;
  const started = Date.now();
  status.lastPollStartedAt = started;
  status.lastProgressAt = started;

  /** Heartbeat: a completed step. Ignored once this poll has been abandoned. */
  const progress = () => {
    if (myGen === generation) status.lastProgressAt = Date.now();
  };

  try {
    const ids = await withTimeout(listUnreadInboxIds(), FETCH_TIMEOUT_MS, "listUnreadInboxIds");
    progress();

    // Gmail lists newest first; fetch the batch, then dispatch oldest first.
    const inbound: GmailInbound[] = [];
    for (const id of ids) {
      try {
        const msg = await withTimeout(getInboundMessage(id), FETCH_TIMEOUT_MS, `getInboundMessage(${id})`);
        if (msg) inbound.push(msg);
      } catch (err) {
        console.error(`[Gmail Poller] Failed to fetch message ${id}:`, err);
      }
      progress();
    }
    inbound.sort((a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0));

    if (myGen === generation) {
      status.queueDepth = inbound.length;
      status.oldestQueuedAt = inbound.length > 0 ? Number(inbound[0].internalDate ?? 0) || undefined : undefined;
    }

    for (const msg of inbound) {
      if (myGen !== generation) return; // abandoned mid-loop; the new poll owns the queue
      await handleOne(msg);
      progress();
    }

    if (myGen === generation) {
      status.lastPollCompletedAt = Date.now();
      status.consecutivePollErrors = 0;
      status.lastPollError = undefined;
    }
  } catch (err) {
    if (myGen === generation) {
      status.consecutivePollErrors += 1;
      status.lastPollError = err instanceof Error ? err.message : String(err);
    }
    console.error("[Gmail Poller] Poll error:", err);
  } finally {
    if (myGen === generation) syncing = false;
  }

  // Alerting last, and outside the latch, so a slow or failing notification
  // channel can never be the thing that stops polling.
  await reportStallOrRecovery();
}

/** Claim, dispatch and de-queue a single message. Never throws. */
async function handleOne(msg: GmailInbound): Promise<void> {
  if (!(await claimInboundMessage(msg.id))) {
    console.log(
      `[Gmail Poller] Skipping ${msg.id} (thread ${msg.threadId}): already handled, marking read`,
    );
    await markMessageRead(msg.id).catch((err) =>
      console.error(`[Gmail Poller] Failed to mark handled message ${msg.id} read:`, err),
    );
    return;
  }

  try {
    // Bounded: this await covers the whole agent run, and before it had a
    // deadline one that never returned stopped inbound email for five days.
    await withTimeout(
      handleReceivedEmail(receivedFromGmail(msg)),
      DISPATCH_TIMEOUT_MS,
      `dispatch ${msg.id}`,
    );
    attempts.delete(msg.id);
    status.lastDispatchAt = Date.now();
  } catch (err) {
    const count = (attempts.get(msg.id) ?? 0) + 1;
    attempts.set(msg.id, count);
    const detail = err instanceof Error ? err.message : String(err);
    console.error(
      `[Gmail Poller] Dispatch failed for ${msg.id} (attempt ${count}/${MAX_DISPATCH_ATTEMPTS}):`,
      err,
    );

    if (count < MAX_DISPATCH_ATTEMPTS) {
      // Release the claim so the next tick retries it.
      await releaseInboundMessage(msg.id).catch((e) =>
        console.error(`[Gmail Poller] Failed to release ${msg.id}:`, e),
      );
      return;
    }

    // Out of attempts. Retrying forever is what made this invisible: the queue
    // head failed every tick and looked exactly like an empty mailbox. So
    // de-queue it (the mail stays in the mailbox, just read) and say so loudly
    // — one message nobody answered, named, beats an inbox that silently stops.
    status.quarantined += 1;
    attempts.delete(msg.id);
    await markMessageRead(msg.id).catch((e) =>
      console.error(`[Gmail Poller] Failed to mark quarantined ${msg.id} read:`, e),
    );
    await report({
      kind: "message-quarantined",
      detail:
        `An inbound email could not be dispatched after ${MAX_DISPATCH_ATTEMPTS} attempts and has been ` +
        `skipped so it stops blocking the queue.\n\n` +
        `From: ${msg.from}\nSubject: ${msg.subject}\nGmail message id: ${msg.id}\n\n` +
        `Last error: ${detail}\n\n` +
        `The mail is still in the mailbox (now marked read) — it was never answered.`,
      signature: `quarantined:${errorSignature(detail)}`,
    });
    return;
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

// ── Alerting ──────────────────────────────────────────────────────────

/** True once a stall has been reported, so recovery is worth announcing. */
let stallReported = false;

/** Check the observable conditions (queue age, repeated poll errors) and report. */
async function reportStallOrRecovery(): Promise<void> {
  const now = Date.now();
  const stall = detectStall(status, now);
  if (stall) {
    await report(stall);
    return;
  }
  if (stallReported) {
    stallReported = false;
    alertState = {};
    await deliver(`✅ Inbound email recovered`, formatRecoveryAlert(agentName(), status));
  }
}

/** Throttle, then deliver. Best-effort: an alerting failure never propagates. */
async function report(stall: Stall): Promise<void> {
  const now = Date.now();
  if (!shouldAlert(alertState, stall, now)) return;
  const delivered = await deliver(
    `⚠️ Inbound email is not reaching ${agentName()}`,
    formatStallAlert(agentName(), stall, status),
  );
  // Only a delivered alert marks the problem as reported, so a Slack outage
  // means the next tick tries again rather than going quiet about both.
  if (delivered) {
    alertState = { lastAlertAt: now, lastSignature: stall.signature };
    stallReported = true;
  }
}

/**
 * Put a message on the default channel, falling back to emailing the owner.
 *
 * Note the asymmetry that makes the fallback worth having: inbound email can be
 * dead while outbound is perfectly healthy — they share only the OAuth token —
 * so email really is a usable last resort for exactly this failure.
 */
async function deliver(subject: string, body: string): Promise<boolean> {
  try {
    await sendNotification(DEFAULT_NOTIFICATION_CHANNEL, { message: `*${subject}*\n\n${body}` });
    console.log(`[Gmail Poller] Alerted on ${DEFAULT_NOTIFICATION_CHANNEL}: ${subject}`);
    return true;
  } catch (err) {
    console.error(`[Gmail Poller] ${DEFAULT_NOTIFICATION_CHANNEL} alert failed, falling back to email:`, err);
  }
  return emailOwner(subject, body);
}
