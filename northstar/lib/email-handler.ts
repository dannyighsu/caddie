/**
 * Email Message Handler
 *
 * Processes inbound emails received via Resend webhook.
 * Fetches the full email body from Resend API, strips quoted replies,
 * and delegates to the shared messaging handler.
 *
 * Conversation threading uses the email's References / In-Reply-To headers
 * to identify the root message of a thread, so multiple messages in the same
 * thread are grouped while different threads (even from the same sender) are
 * treated as separate conversations.
 */

import { handleInboundMessage } from "./messaging";
import {
  fetchReceivedEmail,
  sendEmail,
  getFromRawAddress,
} from "./email";

/**
 * Determine the root Message-ID of the email thread by inspecting the
 * References and In-Reply-To headers. Falls back to the email's own
 * Message-ID for new threads (no parent).
 *
 * Header lookups are case-insensitive since email header casing is inconsistent.
 */
function getThreadRootId(
  headers: Record<string, string> | null,
  ownMessageId: string,
): string {
  if (!headers) return ownMessageId;

  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lower[k.toLowerCase()] = v;
  }

  // References contains the full ancestry chain; the first entry is the root.
  const references = lower["references"];
  if (references) {
    const ids = references.match(/<[^>]+>/g);
    if (ids && ids.length > 0) {
      return ids[0];
    }
  }

  // Fall back to In-Reply-To (immediate parent — not strictly the root,
  // but better than nothing for clients that don't set References).
  const inReplyTo = lower["in-reply-to"];
  if (inReplyTo) {
    const match = inReplyTo.match(/<[^>]+>/);
    if (match) return match[0];
  }

  // No parent — this is a new thread, use its own Message-ID as the root.
  return ownMessageId;
}

/**
 * Handle an inbound email webhook event.
 * Called with the email_id from the Resend webhook payload.
 */
export async function handleEmailMessage(
  emailId: string,
  webhookFrom: string,
  webhookSubject: string,
): Promise<void> {
  // Fetch full email content from Resend API
  const email = await fetchReceivedEmail(emailId);
  if (!email) return;

  const from = email.from;
  const subject = email.subject;
  const messageId = email.messageId;

  // Skip emails from our own address (avoid loops)
  if (from === getFromRawAddress()) return;

  // Pass the full email text (including quoted thread history) so the agent
  // always has conversation context, even if session resumption fails.
  const emailText = email.text?.trim();
  if (!emailText) return;

  // Thread by the root Message-ID of the conversation, not by sender.
  // This way two unrelated email threads from the same person become
  // two separate conversations, and reply chains stay grouped.
  const threadRootId = getThreadRootId(email.headers, messageId);
  const externalId = `email:${threadRootId}`;

  try {
    await handleInboundMessage({
      text: emailText,
      externalId,
      traceName: "email-message",
      traceMetadata: {
        from,
        subject,
        messageId,
      },
      context: { originChannel: "email" },
      replyFn: async (replyText) => {
        const cleaned = replyText.replace(/\nhttps?:\/\/[^\s]+$/, "").trim();
        const reSubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
        await sendEmail(from, reSubject, cleaned, messageId);
      },
      routingConfirmFn: async (_label) => {
        // Don't send routing confirmations for email
      },
    });
  } catch (err) {
    console.error("[Email Handler] Error:", err);
  }
}
