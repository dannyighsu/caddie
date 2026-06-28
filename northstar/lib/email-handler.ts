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
  replyToEmail,
  getFromRawAddress,
  resolveEmailIdentity,
  type ReceivedEmail,
} from "./email";

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
  if (email.from === getFromRawAddress()) return;

  const body = email.extractedText.trim();
  if (!body) return;

  const identity = resolveEmailIdentity(email);
  console.log(
    `[Email Handler] Identity: kind=${identity.kind}` +
      (identity.kind === "authenticated" ? ` userId=${identity.userId}` : "") +
      ` rawSender=${identity.rawSender}`,
  );

  const externalId = `email:${email.threadId}`;

  try {
    await handleInboundMessage({
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
        await replyToEmail(email.messageId, cleaned);
      },
    });
  } catch (err) {
    console.error("[Email Handler] Error:", err);
  }
}
