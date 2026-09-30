/**
 * Slack Client
 *
 * Web API for sending messages + Socket Mode for receiving events.
 * Socket Mode connects outbound to Slack (no public URL needed).
 *
 * Env vars:
 *   SLACK_BOT_TOKEN  — for sending messages (xoxb-...)
 *   SLACK_APP_TOKEN  — for Socket Mode connection (xapp-...)
 */

import { WebClient } from "@slack/web-api";
import { SocketModeClient } from "@slack/socket-mode";
import type { ResolvedIdentity, UserId } from "./identity";
import {
  createConversation,
  getConversationByExternalId,
  appendMessages,
  type Message,
} from "./db";
import type { ThreadContext } from "./thread-context";
import {
  collectChannels,
  type ConversationsListPage,
  type ListChannelsOptions,
  type SlackChannelSummary,
} from "./slack-channels";
import { defaultAgentId } from "./harness";
import { teamLookup } from "@ignis/harness";


// --- Web API (sending) ---

let webClient: WebClient | null = null;

function getWebClient(): WebClient {
  if (!webClient) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("SLACK_BOT_TOKEN environment variable is not set");
    }
    webClient = new WebClient(token);
  }
  return webClient;
}

export async function sendMessage(
  channel: string,
  text: string
): Promise<string | undefined> {
  const result = await getWebClient().chat.postMessage({ channel, text });
  return result.ts;
}

export async function replyInThread(
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  await getWebClient().chat.postMessage({
    channel,
    text,
    thread_ts: threadTs,
  });
}

export function isSlackConfigured(): boolean {
  return !!process.env.SLACK_BOT_TOKEN;
}

// --- Channel discovery ---

/** Public channels plus the private ones the bot has been invited to. */
const DEFAULT_CHANNEL_TYPES = "public_channel,private_channel";

/** Slack's own per-page maximum for `conversations.list`. */
const PAGE_SIZE = 200;

/**
 * List the workspace's channels, following the `conversations.list` cursor to
 * the end rather than returning only the first page.
 *
 * Needs `channels:read` on the bot token for public channels and `groups:read`
 * for the private ones it belongs to; without a scope Slack omits that class of
 * channel rather than erroring, so a missing scope shows up as a short list.
 */
export async function listChannels(
  options: ListChannelsOptions & { types?: string } = {},
): Promise<{ channels: SlackChannelSummary[]; truncated: boolean }> {
  const client = getWebClient();
  const types = options.types?.trim() || DEFAULT_CHANNEL_TYPES;

  return collectChannels(async (cursor) => {
    const page = await client.conversations.list({
      types,
      limit: PAGE_SIZE,
      exclude_archived: !options.includeArchived,
      ...(cursor && { cursor }),
    });
    return page as ConversationsListPage;
  }, options);
}

export type { SlackChannelSummary } from "./slack-channels";

/**
 * Register (or append to) the local conversation for an outbound Slack message,
 * keyed by the message's thread root, so a reply in that thread matches an
 * existing conversation. The reply handler then starts with history (the posted
 * message as an assistant turn) and — when the post came from one of Buri's own
 * tasks — the source-task facts (`thread_context`) it needs to act on the reply
 * (e.g. stop a recurring job). This is the Slack counterpart to email's
 * outbound-thread recording; without it a reply lands in a blank session with no
 * idea what thread it came from.
 *
 * `threadTs` is the thread root: the message's own `ts` for a new top-level post,
 * or the parent `thread_ts` when posting into an existing thread. Idempotent per
 * thread — subsequent posts append rather than duplicate the conversation.
 *
 * Best-effort by contract: a record failure is logged and swallowed so it can
 * never fail the send that already succeeded. Callers invoke it only after a
 * successful post.
 */
export async function recordOutboundSlackThread(
  channel: string,
  threadTs: string,
  body: string,
  threadContext?: ThreadContext,
): Promise<void> {
  try {
    const externalId = `slack:${channel}:${threadTs}`;
    const existing = await getConversationByExternalId(externalId);
    const conversationId = existing
      ? existing.id
      : (
          await createConversation(
            await defaultAgentId(),
            body.slice(0, 80),
            externalId,
            undefined,
            threadContext,
          )
        ).id;

    const message: Message = {
      role: "assistant",
      content: body,
      timestamp: new Date().toISOString(),
    };
    await appendMessages(conversationId, [message]);
  } catch (err) {
    console.error(
      `[Slack] Posted to ${channel} (thread ${threadTs}) but failed to record local conversation:`,
      err,
    );
  }
}

// --- Socket Mode (receiving) ---

export type SlackMessageHandler = (event: {
  text: string;
  channel: string;
  ts: string;
  threadTs?: string;
  user: string;
}) => Promise<void>;

let socketClient: SocketModeClient | null = null;
let socketStarted = false;

/**
 * Start the Socket Mode client to receive Slack events.
 * Safe to call multiple times — only starts once.
 */
export function startSocketMode(onMessage: SlackMessageHandler): void {
  if (socketStarted) return;

  const appToken = process.env.SLACK_APP_TOKEN;
  const botToken = process.env.SLACK_BOT_TOKEN;

  if (!appToken || !botToken) {
    console.warn("[Slack] SLACK_APP_TOKEN or SLACK_BOT_TOKEN not set, Socket Mode disabled");
    return;
  }

  socketStarted = true;
  socketClient = new SocketModeClient({ appToken });

  // Handle @mentions only — all bot interactions require an @mention
  socketClient.on("app_mention", async ({ event, ack }) => {
    await ack();

    if (event.bot_id) {
      console.log(
        `[Slack Socket] Skipping mention: from bot (bot_id=${event.bot_id}) channel=${event.channel}`,
      );
      return;
    }

    const text = (event.text as string ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) {
      console.log(
        `[Slack Socket] Skipping mention: empty text after stripping mention user=${event.user} channel=${event.channel}`,
      );
      return;
    }

    try {
      await onMessage({
        text,
        channel: event.channel as string,
        ts: event.ts as string,
        threadTs: event.thread_ts as string | undefined,
        user: event.user as string,
      });
    } catch (err) {
      console.error("[Slack Socket] Mention handler error:", err);
    }
  });

  socketClient.on("connected", () => {
    console.log("[Slack] Socket Mode connected");
  });

  socketClient.on("disconnected", () => {
    console.warn("[Slack] Socket Mode disconnected, will reconnect...");
  });

  socketClient.start().catch((err) => {
    console.error("[Slack] Socket Mode failed to start:", err);
    socketStarted = false;
  });
}

// --- Identity resolution ---

/** Slack user id -> team member id, from the roster. */
function teamSlackMap(): Map<string, UserId> {
  return teamLookup("slackId");
}

/**
 * Resolve a Slack `event.user` ID against the team roster.
 * Socket Mode events are not per-event signed, but the connection is
 * token-authenticated and `event.bot_id` is filtered upstream, so `user`
 * is treated as a verified ID.
 */
export function resolveSlackIdentity(user: string): ResolvedIdentity {
  const userId = teamSlackMap().get(String(user).toLowerCase());
  if (userId) {
    return { kind: "authenticated", userId, channel: "slack", rawSender: user };
  }
  return { kind: "guest", channel: "slack", rawSender: user };
}
