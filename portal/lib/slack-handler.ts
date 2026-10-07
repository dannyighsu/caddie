/**
 * Slack Message Handler
 *
 * Processes inbound Slack messages received via Socket Mode.
 * Delegates to the shared messaging handler for classification,
 * agent execution, and conversation persistence.
 *
 * This handler owns the Slack reply — the agent is launched directly
 * and the handler replies in the Slack thread with the result.
 *
 * Files uploaded with the message are downloaded into the thread's
 * run-artifacts directory and passed as channel-agnostic Attachments, the same
 * path email and Telegram use (selection in ./slack-files, download in
 * ./slack-attachments). One that was uploaded but couldn't be fetched is still
 * named in the prompt — an attachment the agent can't see at all is one it will
 * tell the sender never arrived.
 */

import { replyInThread, resolveSlackIdentity } from "./slack";
import { handleInboundMessage } from "./messaging";
import type { SlackMessageHandler } from "./slack";
import { selectInboundSlackFiles, unretrievedNotice } from "./slack-files";
import { collectThreadSlackFiles, downloadSlackFiles } from "./slack-attachments";

export const handleSlackMessage: SlackMessageHandler = async ({
  text,
  channel,
  ts,
  threadTs,
  user,
  files,
}) => {
  const conversationThreadTs = threadTs ?? ts;
  const identity = resolveSlackIdentity(user);
  console.log(
    `[Slack Handler] Identity: kind=${identity.kind}` +
      (identity.kind === "authenticated" ? ` userId=${identity.userId}` : "") +
      ` rawSender=${identity.rawSender}`,
  );

  // Download uploads before launching. The `[attachment:<fileName>]` markers
  // matter as much as the bytes: the messaging layer matches attachments to
  // turns by those markers, and they're stored with the message, so a file
  // stays resolvable when the thread is re-read on a later turn.
  const { fetch: toFetch, listOnly } = selectInboundSlackFiles(files ?? []);
  const { saved, failed } = await downloadSlackFiles(toFetch, channel, conversationThreadTs);
  const markers = saved.map((a) => `[attachment:${a.fileName}]`);
  const notices = [
    ...failed.map(({ file, reason }) => unretrievedNotice(file, reason)),
    ...listOnly.map(({ file, reason }) => unretrievedNotice(file, reason)),
  ];
  // A file-only message ("@buri" + a screenshot) still has to say something.
  const bodyText = text || "[Slack message with no text]";
  const promptText = [bodyText, ...markers, ...notices].join("\n");
  // Pass everything saved for the thread, not just this message's — the
  // messaging layer narrows it to what the conversation window references.
  const attachments = await collectThreadSlackFiles(channel, conversationThreadTs);
  if (files?.length) {
    console.log(
      `[Slack Handler] Files: saved=${saved.length} failed=${failed.length} ` +
        `listOnly=${listOnly.length} thread=${attachments.length}`,
    );
  }

  const externalId = `slack:${channel}:${conversationThreadTs}`;
  await handleInboundMessage({
    text: promptText,
    externalId,
    traceName: "slack-message",
    identity,
    traceMetadata: { channel, text: text.substring(0, 100) },
    context: { originChannel: "slack" },
    attachments: attachments.length > 0 ? attachments : undefined,
    // Inbound conversations respond via the `reply` tool (with the escape hatch);
    // only direct portal runs auto-deliver final text.
    deliveryMode: "tool",
    replyTarget: { channel: "slack", externalId, slack: { channel, threadTs: conversationThreadTs } },
    // Used only for the error-notice path in tool mode.
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
