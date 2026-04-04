/**
 * Slack Message Handler
 *
 * Processes inbound Slack messages received via Socket Mode.
 * Delegates to the shared messaging handler for classification,
 * agent execution, and conversation persistence.
 *
 * This handler owns the Slack reply — orchestrators are told to skip
 * their own Slack posting via skipSlack: true.
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
    replyFn: async (replyText) => {
      // Format trace links as Slack mrkdwn
      const formatted = replyText.replace(
        /\n(https?:\/\/[^\s]+)$/,
        (_, url) => `\n<${url}|View trace>`
      );
      await replyInThread(channel, conversationThreadTs, formatted);
    },
    routingConfirmFn: async (label) => {
      await replyInThread(channel, conversationThreadTs, `_Routed to ${label}_`);
    },
  });
};
