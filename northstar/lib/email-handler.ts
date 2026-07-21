/**
 * Email Message Handler
 *
 * Processes inbound emails received via the AgentMail webhook.
 * Threads are grouped by AgentMail's `threadId`, so multiple messages in the
 * same thread land in the same conversation while different threads — even
 * from the same sender — stay separate.
 */

import { handleInboundMessage } from "./messaging";
import {
  normalizeMessage,
  fetchMessage,
  fetchRfcMessageId,
  replyToEmail,
  getFromRawAddress,
  resolveEmailIdentity,
  type ReceivedEmail,
} from "./email";
import { getConversationByExternalId, addSeenChannelIds } from "./db";
import { selectInboundBody, isForwardedMessage } from "./email-threading";

export async function handleEmailMessage(rawMessage: unknown): Promise<void> {
  let email: ReceivedEmail;
  try {
    email = normalizeMessage(rawMessage);
  } catch (err) {
    console.error("[Email Handler] Failed to parse message:", err);
    return;
  }

  if (!email.messageId || !email.threadId) {
    console.error(
      "[Email Handler] Missing IDs after normalize. Raw message keys:",
      rawMessage && typeof rawMessage === "object"
        ? Object.keys(rawMessage as object)
        : typeof rawMessage,
      "extracted:",
      { messageId: email.messageId, threadId: email.threadId, from: email.from },
    );
    return;
  }

  // Skip emails from our own address (avoid loops)
  if (email.from === getFromRawAddress()) {
    console.log(
      `[Email Handler] Skipping message: self-sent (loop prevention) from=${email.from} thread=${email.threadId}`,
    );
    return;
  }

  // The webhook offloads the body for all but the smallest messages: text/html
  // are absent and only `preview` + a short-lived `body_url` are sent. When
  // nothing inlined arrived at all, fetch the full message by id and use that.
  if (!email.extractedText.trim() && !email.fullText.trim()) {
    const full = await fetchMessage(email.messageId);
    if (full) email = full;
  }

  const externalId = `email:${email.threadId}`;
  const existing = await getConversationByExternalId(externalId);

  // Choose the body. Normally the quoted-history-stripped text (the agent
  // already holds prior turns); but the FULL body *with* quoted history when
  // this message loops the agent into context it hasn't seen — a forward, a
  // reply into a thread we hold no record of, or a reply whose parent arrived
  // off our inbox (a side conversation). See ./email-threading.
  const selection = selectInboundBody({
    extractedText: email.extractedText,
    fullText: email.fullText,
    isForward: isForwardedMessage(email.subject, email.fullText),
    inReplyTo: email.inReplyTo,
    threadKnownLocally: !!existing,
    knownMessageIds: new Set(existing?.seen_channel_ids ?? []),
  });
  const body = selection.body.trim();
  if (!body) {
    console.log(
      `[Email Handler] Skipping message: empty body from=${email.from} thread=${email.threadId} ` +
        `(after fetch: text=${email.text.length}b html=${email.html.length}b subject="${email.subject}")`,
    );
    return;
  }

  const identity = resolveEmailIdentity(email);
  console.log(
    `[Email Handler] Identity: kind=${identity.kind}` +
      (identity.kind === "authenticated" ? ` userId=${identity.userId}` : "") +
      ` rawSender=${identity.rawSender}`,
  );
  console.log(
    `[Email Handler] Body selected: reason=${selection.reason} ` +
      `includedHistory=${selection.includedHistory} threadKnown=${!!existing}`,
  );

  let replyAgentMessageId: string | undefined;
  try {
    const result = await handleInboundMessage({
      text: body,
      externalId,
      traceName: "email-message",
      identity,
      traceMetadata: {
        from: email.from,
        subject: email.subject,
        messageId: email.messageId,
        threadId: email.threadId,
      },
      context: { originChannel: "email" },
      replyFn: async (replyText) => {
        const cleaned = replyText.replace(/\nhttps?:\/\/[^\s]+$/, "").trim();
        const sent = await replyToEmail(email.messageId, cleaned);
        replyAgentMessageId = sent.messageId;
      },
    });

    // Record the RFC Message-IDs now seen on this thread — the inbound message
    // and our own reply — so a future reply to either is recognized as a direct
    // continuation rather than a side-conversation gap.
    const seen: string[] = [];
    if (email.rfcMessageId) seen.push(email.rfcMessageId);
    if (replyAgentMessageId) {
      const replyRfcId = await fetchRfcMessageId(replyAgentMessageId);
      if (replyRfcId) seen.push(replyRfcId);
    }
    if (seen.length > 0) await addSeenChannelIds(result.conversationId, seen);
  } catch (err) {
    console.error("[Email Handler] Error:", err);
  }
}
