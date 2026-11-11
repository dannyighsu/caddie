/**
 * Inbound Slack interactions — what a click on a Block Kit form means.
 *
 * Pure: no API client, no socket. A form is a message the agent posted with
 * `input` blocks and a submit button (or just buttons or a select for a one-tap
 * answer). Slack sends a `block_actions` payload for the click, carrying every
 * field's current value in `state.values`, keyed by ids rather than labels, so
 * the labels are read back off the message's own blocks.
 *
 * The payload arrives over Socket Mode, or over HTTP when the app has Socket Mode
 * off. Only HTTP is per-request signed; see verifySlackSignature.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { SlackBlock } from "./slack-blocks.ts";

interface SlackOption {
  text?: { text?: string };
  value?: string;
}

/** An element's value, as it appears in `actions[]` and `state.values`. */
interface SlackElementValue {
  type?: string;
  value?: string | null;
  selected_option?: SlackOption | null;
  selected_options?: SlackOption[];
  selected_user?: string | null;
  selected_users?: string[];
  selected_channel?: string | null;
  selected_channels?: string[];
  selected_conversation?: string | null;
  selected_conversations?: string[];
  selected_date?: string | null;
  selected_time?: string | null;
  selected_date_time?: number | null;
  rich_text_value?: unknown;
}

interface SlackAction extends SlackElementValue {
  action_id?: string;
  block_id?: string;
  text?: { text?: string };
  /** Set on a link button, which opens the URL and answers nothing. */
  url?: string;
}

/** The fields of an interaction payload this path uses; all optional, as Slack's shape is untrusted. */
export interface SlackInteractionPayload {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; thread_ts?: string; text?: string; blocks?: SlackBlock[] };
  actions?: SlackAction[];
  state?: { values?: Record<string, Record<string, SlackElementValue>> };
}

export type InteractionDecision =
  | {
      action: "handle";
      text: string;
      channel: string;
      ts: string;
      threadTs?: string;
      user: string;
      /** The message's blocks with the form taken out, to replace it once answered. */
      closedBlocks: SlackBlock[];
      /** The message's fallback text, which `chat.update` would otherwise clear. */
      fallbackText: string;
    }
  | { action: "skip"; reason: string };

function optionLabel(option: SlackOption): string {
  const label = option.text?.text ?? "";
  const value = option.value;
  return value && value !== label ? `${label} (${value})` : label;
}

function mention(id: string): string {
  return `<@${id}>`;
}

function channelLink(id: string): string {
  return `<#${id}>`;
}

/** Every `text` leaf of a rich text value, in order. */
function richTextToPlain(node: unknown): string {
  if (Array.isArray(node)) return node.map(richTextToPlain).join("");
  if (!node || typeof node !== "object") return "";
  const { text, elements } = node as { text?: unknown; elements?: unknown };
  return (typeof text === "string" ? text : "") + richTextToPlain(elements);
}

/** One element's value as text, or "" when it's empty. */
function renderValue(el: SlackElementValue): string {
  if (el.selected_option) return optionLabel(el.selected_option);
  if (el.selected_options) return el.selected_options.map(optionLabel).join(", ");
  if (el.selected_user) return mention(el.selected_user);
  if (el.selected_users) return el.selected_users.map(mention).join(", ");
  if (el.selected_channel) return channelLink(el.selected_channel);
  if (el.selected_channels) return el.selected_channels.map(channelLink).join(", ");
  if (el.selected_conversation) return channelLink(el.selected_conversation);
  if (el.selected_conversations) return el.selected_conversations.map(channelLink).join(", ");
  if (el.selected_date) return el.selected_date;
  if (el.selected_time) return el.selected_time;
  if (el.selected_date_time) return new Date(el.selected_date_time * 1000).toISOString();
  if (el.rich_text_value) return richTextToPlain(el.rich_text_value).trim();
  return el.value ?? "";
}

/** block_id -> the label its `input` block shows. */
function inputLabels(blocks: SlackBlock[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const block of blocks) {
    const label = (block.label as { text?: string } | undefined)?.text;
    if (block.type === "input" && typeof block.block_id === "string" && label) {
      labels.set(block.block_id, label);
    }
  }
  return labels;
}

function renderAction(action: SlackAction): string {
  const details = [`action_id: ${action.action_id}`];
  if (action.type === "button") {
    if (action.value) details.push(`value: ${action.value}`);
    return `Clicked: ${action.text?.text ?? "button"} (${details.join(", ")})`;
  }
  return `Chose: ${renderValue(action) || "(blank)"} (${details.join(", ")})`;
}

function renderFields(payload: SlackInteractionPayload, actions: SlackAction[]): string[] {
  const labels = inputLabels(payload.message?.blocks ?? []);
  const lines: string[] = [];
  for (const [blockId, elements] of Object.entries(payload.state?.values ?? {})) {
    for (const [actionId, element] of Object.entries(elements)) {
      // The element that fired is already on the Clicked/Chose line.
      if (actions.some((a) => a.block_id === blockId && a.action_id === actionId)) continue;
      lines.push(`${labels.get(blockId) ?? actionId}: ${renderValue(element) || "(blank)"}`);
    }
  }
  return lines;
}

/**
 * The message as it should read once answered: no inputs, no buttons, and a line
 * saying who answered, so the form can't be sent twice and the person sees it
 * went through.
 */
export function closeForm(blocks: SlackBlock[], user: string): SlackBlock[] {
  const kept: SlackBlock[] = [];
  for (const block of blocks) {
    if (block.type === "input" || block.type === "actions") continue;
    const accessory = block.accessory as { type?: string } | undefined;
    if (accessory && accessory.type !== "image") {
      const { accessory: _dropped, ...rest } = block;
      kept.push(rest);
    } else {
      kept.push(block);
    }
  }
  return [
    ...kept.slice(0, 49),
    { type: "context", elements: [{ type: "mrkdwn", text: `Submitted by ${mention(user)}` }] },
  ];
}

/**
 * Decide whether an interaction is a response the agent should get, and as what
 * text. Anything else still has to be acknowledged, which the transport does
 * before asking.
 */
export function decideInteraction(payload: SlackInteractionPayload): InteractionDecision {
  const skip = (reason: string): InteractionDecision => ({ action: "skip", reason });

  if (payload.type !== "block_actions") return skip(`type=${payload.type}`);
  const user = payload.user?.id;
  const channel = payload.channel?.id;
  const message = payload.message;
  if (!user) return skip("no sender");
  if (!channel || !message?.ts) return skip("not on a message");

  const actions = (payload.actions ?? []).filter((a) => !a.url);
  if (actions.length === 0) return skip("no action to answer");

  const text = [
    "[Slack form response]",
    ...actions.map(renderAction),
    ...renderFields(payload, actions),
  ].join("\n");

  return {
    action: "handle",
    text,
    channel,
    ts: message.ts,
    threadTs: message.thread_ts,
    user,
    closedBlocks: closeForm(message.blocks ?? [], user),
    fallbackText: message.text ?? "",
  };
}

/** Slack sends interactions form-encoded, with the JSON in a `payload` field. */
export function parseInteractionBody(rawBody: string): SlackInteractionPayload | null {
  const encoded = new URLSearchParams(rawBody).get("payload");
  if (!encoded) return null;
  try {
    const parsed: unknown = JSON.parse(encoded);
    return parsed && typeof parsed === "object" ? (parsed as SlackInteractionPayload) : null;
  } catch {
    return null;
  }
}

/** How old a signed request may be, in seconds. Slack's recommended replay window. */
const MAX_SIGNATURE_AGE = 60 * 5;

/**
 * Check Slack's `X-Slack-Signature` over the raw body. Socket Mode needs none of
 * this: its connection is token-authenticated.
 */
export function verifySlackSignature(input: {
  secret: string;
  timestamp: string | null;
  signature: string | null;
  rawBody: string;
  nowSeconds?: number;
}): boolean {
  const { secret, timestamp, signature, rawBody } = input;
  if (!timestamp || !signature) return false;

  const sent = Number(timestamp);
  const now = input.nowSeconds ?? Date.now() / 1000;
  if (!Number.isFinite(sent) || Math.abs(now - sent) > MAX_SIGNATURE_AGE) return false;

  const expected =
    "v0=" + createHmac("sha256", secret).update(`v0:${timestamp}:${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
