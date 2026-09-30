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

/** The scope `files.getUploadURLExternal` needs; Slack reports it on failure. */
const FILE_UPLOAD_SCOPE = "files:write";

/**
 * Upload a file into a channel (or thread), with `text` as the message that
 * introduces it. Returns the ts of the message the file was shared in, when
 * Slack reports one — the share is finalized asynchronously, so it can be
 * missing even on success.
 *
 * Unlike a text post, sharing a file needs channel membership even with
 * `chat:write.public`. So on `not_in_channel` the bot joins (public channels
 * only, via `channels:join`) and retries once; a private channel still needs
 * an invite.
 *
 * Needs `files:write` on the bot token. Without it Slack answers
 * `missing_scope`, which is rethrown with the fix spelled out, because the raw
 * error names neither the scope nor where to add it.
 */
export async function uploadFile(
  channel: string,
  file: { filename: string; data: Buffer; title?: string },
  text: string,
  threadTs?: string,
): Promise<string | undefined> {
  const client = getWebClient();
  const upload = {
    channel_id: channel,
    file: file.data,
    filename: file.filename,
    title: file.title ?? file.filename,
    initial_comment: text,
  };
  const send = () =>
    client.filesUploadV2(threadTs ? { ...upload, thread_ts: threadTs } : upload);

  let result;
  try {
    try {
      result = await send();
    } catch (err) {
      if (slackError(err)?.error !== "not_in_channel") throw err;
      await client.conversations.join({ channel });
      console.log(`[Slack] Joined ${channel} to share ${file.filename}`);
      result = await send();
    }
  } catch (err) {
    const data = slackError(err);
    if (data?.error === "missing_scope") {
      throw new Error(
        `Slack bot token lacks the ${data.needed ?? FILE_UPLOAD_SCOPE} scope. ` +
          `Add it under OAuth & Permissions in the Slack app settings and reinstall the app.`,
      );
    }
    if (data?.error === "method_not_supported_for_channel_type" || data?.error === "channel_not_found") {
      throw new Error(
        `Can't share a file in ${channel}: the bot isn't in it and can't join it on its own ` +
          `(a private channel needs someone to invite the bot).`,
      );
    }
    throw err;
  }

  // The SDK types only `public` shares; private channels come back under `private`.
  type Share = { ts?: string; thread_ts?: string };
  const shared = result.files?.[0]?.files?.[0]?.shares as
    | { public?: Record<string, Share[]>; private?: Record<string, Share[]> }
    | undefined;
  const share = shared?.public?.[channel]?.[0] ?? shared?.private?.[channel]?.[0];
  return threadTs ?? share?.thread_ts ?? share?.ts;
}

/** The `data` a Slack Web API error carries, if it is one. */
function slackError(err: unknown): { error?: string; needed?: string } | undefined {
  return (err as { data?: { error?: string; needed?: string } }).data;
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
