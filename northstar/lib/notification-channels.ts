/**
 * Notification Channels
 *
 * Shared type and dispatcher for sending notifications across channels.
 * Used by the scheduler and control API to route messages to Slack, Telegram, or email.
 */

import { sendMessage, isSlackConfigured } from "./slack";
import { sendTelegramMessage, isTelegramConfigured } from "./telegram";
import { sendEmail, isEmailConfigured } from "./email";
import { getSetting } from "./db";
import type { ThreadContext } from "./thread-context";

export const NOTIFICATION_CHANNELS = ["slack", "telegram", "email"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const DEFAULT_NOTIFICATION_CHANNEL: NotificationChannel = "slack";

export function isNotificationChannel(value: unknown): value is NotificationChannel {
  return typeof value === "string" && (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

export interface NotificationOptions {
  /** The message body */
  message: string;
  /** Optional sender label, prepended to the message */
  from?: string;
  /** Channel-specific recipient override (Slack channel ID, Telegram chat ID, or email) */
  recipient?: string;
  /** Email subject (only used for email channel) */
  subject?: string;
  /** Source-task facts to attach to the created email thread (email channel only). */
  threadContext?: ThreadContext;
}

/**
 * Send a notification to the specified channel.
 * Falls back to channel-appropriate defaults if no recipient is provided.
 */
export async function sendNotification(
  channel: NotificationChannel,
  options: NotificationOptions,
): Promise<void> {
  const { message, from } = options;
  const formatted = from ? `*[${from}]* ${message}` : message;

  if (channel === "slack") {
    if (!isSlackConfigured()) {
      throw new Error("Slack is not configured");
    }
    let channelId = options.recipient;
    if (!channelId) {
      const defaultChannel = await getSetting<{ channelId: string }>("default_slack_channel");
      channelId = defaultChannel?.channelId;
    }
    if (!channelId) {
      throw new Error("No Slack channel specified and no default configured");
    }
    await sendMessage(channelId, formatted);
    return;
  }

  if (channel === "telegram") {
    if (!isTelegramConfigured()) {
      throw new Error("Telegram is not configured");
    }
    let recipient = options.recipient;
    if (!recipient) {
      const config = await getSetting<{ defaultRecipient?: string }>("telegram_config");
      recipient = config?.defaultRecipient;
    }
    if (!recipient) {
      throw new Error("No Telegram recipient specified and no default configured");
    }
    await sendTelegramMessage(recipient, formatted);
    return;
  }

  if (channel === "email") {
    if (!isEmailConfigured()) {
      throw new Error("Email is not configured");
    }
    if (!options.recipient) {
      throw new Error("Email recipient is required");
    }
    const subject = options.subject ?? "Notification";
    await sendEmail(options.recipient, subject, formatted, { threadContext: options.threadContext });
    return;
  }

  throw new Error(`Unknown notification channel: ${channel}`);
}
