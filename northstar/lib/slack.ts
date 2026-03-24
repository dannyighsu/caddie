/**
 * Slack Client
 *
 * Direct Slack Web API integration for sending messages.
 * No ChatKit/Porter abstraction — just @slack/web-api.
 */

import { WebClient } from "@slack/web-api";

let client: WebClient | null = null;

function getClient(): WebClient {
  if (!client) {
    const token = process.env.SLACK_BOT_TOKEN;
    if (!token) {
      throw new Error("SLACK_BOT_TOKEN environment variable is not set");
    }
    client = new WebClient(token);
  }
  return client;
}

/**
 * Send a message to a Slack channel.
 */
export async function sendMessage(
  channel: string,
  text: string
): Promise<string | undefined> {
  const result = await getClient().chat.postMessage({ channel, text });
  return result.ts; // thread timestamp for replies
}

/**
 * Reply in a Slack thread.
 */
export async function replyInThread(
  channel: string,
  threadTs: string,
  text: string
): Promise<void> {
  await getClient().chat.postMessage({
    channel,
    text,
    thread_ts: threadTs,
  });
}

/**
 * Check if Slack is configured (token is set).
 */
export function isSlackConfigured(): boolean {
  return !!process.env.SLACK_BOT_TOKEN;
}
