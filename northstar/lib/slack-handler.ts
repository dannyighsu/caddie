/**
 * Slack Message Handler
 *
 * Processes inbound Slack messages received via Socket Mode.
 * Delegates to the shared messaging handler for classification,
 * agent execution, and conversation persistence.
 *
 * This handler owns the Slack reply — the agent is launched directly
 * and the handler replies in the Slack thread with the result.
 */

import { replyInThread } from "./slack";
import { handleInboundMessage } from "./messaging";
import type { SlackMessageHandler } from "./slack";

export const handleSlackMessage: SlackMessageHandler = async ({
  text,
  channel,
  ts,
  threadTs,
}) => {
  const conversationThreadTs = threadTs ?? ts;

  await handleInboundMessage({
    text,
    externalId: `slack:${channel}:${conversationThreadTs}`,
    traceName: "slack-message",
    traceMetadata: { channel, text: text.substring(0, 100) },
    context: { originChannel: "slack" },
    replyFn: async (replyText) => {
      // Format trace links as Slack mrkdwn
      const formatted = replyText.replace(
        /\n(https?:\/\/[^\s]+)$/,
        (_, url) => `\n<${url}|View trace>`
      );
      await replyInThread(channel, conversationThreadTs, formatted);
    },
  });
};
