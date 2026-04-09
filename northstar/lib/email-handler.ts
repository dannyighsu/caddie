/**
 * Email Message Handler
 *
 * Processes inbound emails received via Resend webhook.
 * Fetches the full email body from Resend API, strips quoted replies,
 * and delegates to the shared messaging handler.
 *
 * Conversations are threaded by sender email address.
 */

import { handleInboundMessage } from "./messaging";
import {
  fetchReceivedEmail,
  extractLatestReply,
  sendEmail,
  getFromRawAddress,
} from "./email";

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

  // Extract just the latest reply text
  const latestText = extractLatestReply(email.text);
  if (!latestText) return;

  const externalId = `email:${from}`;

  try {
    await handleInboundMessage({
      text: latestText,
      externalId,
      traceName: "email-message",
      traceMetadata: {
        from,
        subject,
        messageId,
      },
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
