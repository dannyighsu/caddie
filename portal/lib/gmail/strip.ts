/**
 * Quoted-reply stripping — the local replacement for AgentMail's `extracted_text`.
 *
 * Uses crisp-oss/email-reply-parser (battle-tested on ~1M emails/day) to pull the
 * new, visible message out of a plain-text email body, dropping quoted history and
 * signatures. Buri's selectInboundBody still keeps the FULL body around and prefers
 * it for forwards/gaps/loop-ins, so this only governs the ordinary-reply case.
 */

import EmailReplyParser from "email-reply-parser";

export function stripQuotedReply(text: string): string {
  if (!text || !text.trim()) return "";
  try {
    const visible = new EmailReplyParser().read(text).getVisibleText();
    return visible?.trim() || text.trim();
  } catch {
    return text.trim();
  }
}
