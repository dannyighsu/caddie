/**
 * Channel-agnostic identity types.
 *
 * Each channel handler (email, Slack, Telegram, ...) resolves the inbound
 * sender to a ResolvedIdentity at the boundary, then passes it as a trusted
 * field into the shared messaging handler. Downstream code reads only this
 * field — never raw channel data — to decide trust.
 */

export type UserId = "danny" | "betty";

export type Channel = "email" | "slack" | "telegram";

export type ResolvedIdentity =
  | {
      kind: "authenticated";
      userId: UserId;
      channel: Channel;
      /** Original channel-specific sender, kept for tracing and replies. */
      rawSender: string;
    }
  | {
      kind: "guest";
      channel: Channel;
      rawSender: string;
    };

/** Trust tier matching the harness `TrustTier` type (kept independent to avoid cross-package imports). */
export type TrustTier = "household" | "guest";

export function toTrustTier(identity: ResolvedIdentity): TrustTier {
  return identity.kind === "authenticated" ? "household" : "guest";
}

const USER_LABELS: Record<UserId, string> = {
  danny: "Danny",
  betty: "Betty",
};

const CHANNEL_LABELS: Record<Channel, string> = {
  email: "email",
  slack: "Slack",
  telegram: "Telegram",
};

/**
 * Human-readable identity string for the persona context. Intentionally omits
 * the rawSender — that's attacker-controlled for guests and we don't want it in
 * the system prompt where it could carry prompt-injection payloads.
 */
export function describeSender(identity: ResolvedIdentity): string {
  const via = CHANNEL_LABELS[identity.channel];
  if (identity.kind === "authenticated") {
    return `${USER_LABELS[identity.userId]} (household member, verified via ${via})`;
  }
  return `unverified sender (guest, via ${via})`;
}
