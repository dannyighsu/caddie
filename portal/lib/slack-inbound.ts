/**
 * Inbound Slack message events — which ones the agent answers.
 *
 * Pure: no API client, no socket. Channels reach the agent through `app_mention`
 * alone, but Slack never sends that event for a 1:1 DM, so DMs arrive as plain
 * `message` events (`message.im`, `message.mpim`) and the rule is applied here:
 * a 1:1 DM is always for the agent; a group DM only when it mentions the bot.
 *
 * `message` is a noisy event. It fires for the bot's own replies, so answering
 * one unfiltered is a loop, and for edits, deletions and other housekeeping,
 * which Slack marks with a `subtype`.
 */

import type { SlackFile } from "./slack-files.ts";

/** The fields of a `message` event this path uses; all optional, as Slack's shape is untrusted. */
export interface SlackMessageEvent {
  subtype?: string;
  bot_id?: string;
  user?: string;
  text?: string;
  channel?: string;
  channel_type?: string;
  ts?: string;
  thread_ts?: string;
  files?: SlackFile[];
}

/** Subtypes that are still a person saying something. Any other is housekeeping. */
const PERSON_SUBTYPES = new Set(["file_share", "thread_broadcast"]);

export type DirectMessageDecision =
  | { action: "handle"; text: string; files: SlackFile[] }
  | { action: "skip"; reason: string };

/** Slack writes a mention as `<@U123>`, or `<@U123|name>` in some payloads. */
function mentionPattern(userId: string): RegExp {
  return new RegExp(`<@${userId}(?:\\|[^>]*)?>`, "g");
}

/**
 * Decide whether a `message` event is one the agent should answer, and with what
 * text. Only the bot's own mention comes out of the text: anyone else named in
 * the message is part of what was said.
 */
export function decideDirectMessage(
  event: SlackMessageEvent,
  botUserId: string,
): DirectMessageDecision {
  const skip = (reason: string): DirectMessageDecision => ({ action: "skip", reason });

  const type = event.channel_type;
  if (type !== "im" && type !== "mpim") return skip(`channel_type=${type}`);
  if (event.bot_id || event.user === botUserId) return skip("from a bot");
  if (!event.user) return skip("no sender");
  if (event.subtype && !PERSON_SUBTYPES.has(event.subtype)) {
    return skip(`subtype=${event.subtype}`);
  }

  const raw = event.text ?? "";
  const pattern = mentionPattern(botUserId);
  if (type === "mpim" && raw.search(pattern) === -1) return skip("group DM without a mention");

  const text = raw.replace(pattern, "").trim();
  const files = event.files ?? [];
  // A file dropped in with no words is a real message, same as in a channel.
  if (!text && files.length === 0) return skip("empty text");
  return { action: "handle", text, files };
}

/**
 * First-claim-wins over `channel:ts`, so one message can't start two runs. Slack
 * doesn't document whether a mention in a group DM also fires `app_mention`, and
 * that event doesn't say what kind of conversation it came from, so both
 * listeners claim the message and whichever arrives second stands down.
 *
 * Holds only the last `limit` claims: the two events arrive moments apart.
 */
export function createMessageClaims(limit = 500): (channel: string, ts: string) => boolean {
  const claimed = new Set<string>();
  return (channel, ts) => {
    const key = `${channel}:${ts}`;
    if (claimed.has(key)) return false;
    claimed.add(key);
    if (claimed.size > limit) {
      const [oldest] = claimed;
      claimed.delete(oldest);
    }
    return true;
  };
}
