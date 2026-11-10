/**
 * Linear webhook payloads: signature check and reading an agent session event.
 * Pure logic, so the route and the handler stay thin and this stays testable.
 *
 * Field names follow Linear's `AgentSessionEventWebhookPayload` in its GraphQL
 * schema. Only the fields used here are typed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

/** Linear's own replay window: reject a delivery stamped more than a minute off. */
export const MAX_WEBHOOK_SKEW_MS = 60 * 1000;

/**
 * `Linear-Signature` is the hex HMAC-SHA256 of the raw body, keyed with the
 * webhook signing secret. Compared in constant time.
 */
export function verifySignature(rawBody: string, signature: string | null, secret: string): boolean {
  if (!signature || !/^[0-9a-f]+$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(signature, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function isFresh(webhookTimestamp: unknown, now: number): boolean {
  return typeof webhookTimestamp === "number" && Math.abs(now - webhookTimestamp) <= MAX_WEBHOOK_SKEW_MS;
}

export interface LinearUser {
  id: string;
  name: string;
  email: string;
  url?: string;
}

export interface AgentSessionEvent {
  type: "AgentSessionEvent";
  action: "created" | "prompted" | string;
  organizationId: string;
  appUserId: string;
  webhookTimestamp: number;
  /** Linear's formatted context: the issue, the comment thread, team guidance. */
  promptContext?: string | null;
  agentSession: {
    id: string;
    url?: string | null;
    creator?: LinearUser | null;
    comment?: { id: string; body: string } | null;
    issue?: {
      id: string;
      identifier: string;
      title: string;
      url: string;
      description?: string | null;
    } | null;
  };
  /** Present on `prompted`: the message the user sent into the session. */
  agentActivity?: {
    id: string;
    content: { type?: string; body?: string } & Record<string, unknown>;
    signal?: string | null;
    user: LinearUser;
  } | null;
}

export function isAgentSessionEvent(payload: unknown): payload is AgentSessionEvent {
  const p = payload as Partial<AgentSessionEvent> | null;
  return !!p && p.type === "AgentSessionEvent" && typeof p.agentSession?.id === "string";
}

/** The person who triggered this event: the prompter, else whoever opened the session. */
export function senderOf(event: AgentSessionEvent): LinearUser | null {
  if (event.action === "prompted") return event.agentActivity?.user ?? null;
  return event.agentSession.creator ?? null;
}

/** A `prompted` event carrying the user's Stop signal. */
export function isStopSignal(event: AgentSessionEvent): boolean {
  return event.action === "prompted" && event.agentActivity?.signal === "stop";
}

/**
 * The message this event delivers, as it's stored in the conversation:
 *   - `prompted`: what the user wrote into the session;
 *   - `created` from a mention: the comment that mentioned the app;
 *   - `created` from delegation: there is no message, the issue is the ask.
 */
export function inboundTextOf(event: AgentSessionEvent): string {
  if (event.action === "prompted") {
    const body = event.agentActivity?.content?.body;
    return typeof body === "string" && body.trim() ? body.trim() : "[empty message]";
  }
  const comment = event.agentSession.comment?.body?.trim();
  if (comment) return comment;
  const issue = event.agentSession.issue;
  return issue ? `Delegated ${issue.identifier} to you: ${issue.title}` : "Opened a session with you";
}

/**
 * The run-context block for this event: where the agent is and what Linear
 * says about it. Not persisted to history, so each run carries the current
 * issue rather than a stale copy.
 */
export function promptContextOf(event: AgentSessionEvent): string {
  const issue = event.agentSession.issue;
  const lines = [
    "## Linear agent session",
    "",
    "This message came from a Linear agent session: someone mentioned you or delegated an issue to you. " +
      "`reply` posts a response into that session, on the issue. Read the `linear` skill.",
  ];
  if (issue) {
    lines.push("", `Issue: ${issue.identifier} ${issue.title}`, `URL: ${issue.url}`);
  }
  if (event.promptContext?.trim()) {
    lines.push("", "Linear's context for this session (issue, comment thread, team guidance):", "", event.promptContext.trim());
  }
  return lines.join("\n");
}
