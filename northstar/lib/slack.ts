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

    if (event.bot_id) return;

    const text = (event.text as string ?? "").replace(/<@[A-Z0-9]+>/g, "").trim();
    if (!text) return;

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
