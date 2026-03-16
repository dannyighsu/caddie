import { query, queryOne } from "./client";
import type { ModelId } from "../ai/model-config";

export interface SlackChannelIdentity {
  appId: string;
  channelId: string;
  teamId: string;
}

export interface XManagerConfig {
  xUsername: string;
  modelId?: ModelId; // Optional, defaults to google/gemini-3-flash-preview
}

interface AppSetting<T> {
  id: string;
  key: string;
  value: T;
  created_at: Date;
  updated_at: Date;
}

const SETTINGS_KEYS = {
  DEFAULT_SLACK_CHANNEL: "default_slack_channel",
  XMANAGER_CONFIG: "xmanager_config",
} as const;

export async function getSetting<T>(key: string): Promise<T | null> {
  const result = await queryOne<AppSetting<T>>(
    `SELECT * FROM app_settings WHERE key = $1`,
    [key]
  );
  return result?.value ?? null;
}

export async function setSetting<T>(key: string, value: T): Promise<void> {
  await query(
    `
    INSERT INTO app_settings (key, value)
    VALUES ($1, $2)
    ON CONFLICT (key)
    DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()
    `,
    [key, JSON.stringify(value)]
  );
}

export async function deleteSetting(key: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM app_settings WHERE key = $1 RETURNING id`,
    [key]
  );
  return result.length > 0;
}

export async function getDefaultSlackChannel(): Promise<SlackChannelIdentity | null> {
  return getSetting<SlackChannelIdentity>(SETTINGS_KEYS.DEFAULT_SLACK_CHANNEL);
}

export async function setDefaultSlackChannel(
  identity: SlackChannelIdentity
): Promise<void> {
  if (!identity.appId || !identity.channelId || !identity.teamId) {
    throw new Error("Slack identity must include appId, channelId, and teamId");
  }
  return setSetting(SETTINGS_KEYS.DEFAULT_SLACK_CHANNEL, identity);
}

export async function clearDefaultSlackChannel(): Promise<boolean> {
  return deleteSetting(SETTINGS_KEYS.DEFAULT_SLACK_CHANNEL);
}

// X Manager Config
export async function getXManagerConfig(): Promise<XManagerConfig | null> {
  return getSetting<XManagerConfig>(SETTINGS_KEYS.XMANAGER_CONFIG);
}

export async function setXManagerConfig(config: XManagerConfig): Promise<void> {
  if (!config.xUsername) {
    throw new Error("X username is required");
  }
  return setSetting(SETTINGS_KEYS.XMANAGER_CONFIG, config);
}

export async function clearXManagerConfig(): Promise<boolean> {
  return deleteSetting(SETTINGS_KEYS.XMANAGER_CONFIG);
}
