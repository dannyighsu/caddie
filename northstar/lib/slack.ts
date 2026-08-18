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

/** Agent a reply to an outbound-initiated Slack thread routes to. */
const OUTBOUND_AGENT_ID = "buri";

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
            OUTBOUND_AGENT_ID,
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

function householdSlackMap(): Map<string, UserId> {
  const map = new Map<string, UserId>();
  const add = (envValue: string | undefined, userId: UserId) => {
    if (!envValue) return;
    for (const raw of envValue.split(",")) {
      const cleaned = raw.trim();
      if (cleaned) map.set(cleaned, userId);
    }
  };
  add(process.env.DANNY_SLACK_USER_ID, "danny");
  add(process.env.BETTY_SLACK_USER_ID, "betty");
  return map;
}

/**
 * Resolve a Slack `event.user` ID against the household allowlist.
 * Socket Mode events are not per-event signed, but the connection is
 * token-authenticated and `event.bot_id` is filtered upstream, so `user`
 * is treated as a verified ID.
 */
export function resolveSlackIdentity(user: string): ResolvedIdentity {
  const userId = householdSlackMap().get(user);
  if (userId) {
    return { kind: "authenticated", userId, channel: "slack", rawSender: user };
  }
  return { kind: "guest", channel: "slack", rawSender: user };
}
