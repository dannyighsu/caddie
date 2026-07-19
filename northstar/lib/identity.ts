/**
 * Channel-agnostic identity types.
 *
 * Each channel handler (email, Slack, Telegram, ...) resolves the inbound
 * sender to a ResolvedIdentity at the boundary, then passes it as a trusted
 * field into the shared messaging handler. Downstream code reads only this
 * field — never raw channel data — to decide trust.
 */

export type UserId = "danny" | "betty";

export type Channel = "email" | "slack" | "telegram" | "portal";

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
  portal: "the control portal",
};

/**
 * Human-readable identity string for the persona context. Intentionally omits
 * the rawSender — that's attacker-controlled for guests and we don't want it in
 * the system prompt where it could carry prompt-injection payloads.
 */
export function describeSender(identity: ResolvedIdentity): string {
  if (identity.channel === "portal") {
    // The portal doesn't verify a specific person — access is gated by the
    // network boundary (localhost/tailnet). So we say "owner", not "verified".
    return identity.kind === "authenticated"
      ? `${USER_LABELS[identity.userId]} (household owner, via the control portal)`
      : "owner (via the control portal)";
  }
  const via = CHANNEL_LABELS[identity.channel];
  if (identity.kind === "authenticated") {
    return `${USER_LABELS[identity.userId]} (household member, verified via ${via})`;
  }
  return `unverified sender (guest, via ${via})`;
}

/**
 * Run identity bundle (trust + sender + origin) passed into `launcher.launch`.
 * Mirrors the harness `RunIdentity` shape; kept structurally compatible so we
 * avoid a cross-package type import here.
 */
export interface RunIdentity {
  trustTier: TrustTier;
  senderIdentity: string;
  originChannel: string;
}

/** Derive the run identity from a resolved sender identity. */
export function toRunIdentity(identity: ResolvedIdentity): RunIdentity {
  return {
    trustTier: toTrustTier(identity),
    senderIdentity: describeSender(identity),
    originChannel: identity.channel,
  };
}

/** Identity for a run initiated from the control portal by a household owner. */
export function portalIdentity(userId: UserId): ResolvedIdentity {
  return { kind: "authenticated", userId, channel: "portal", rawSender: "control-portal" };
}

const USER_IDS: readonly UserId[] = ["danny", "betty"];

/** Owner attributed to portal runs when the selector hasn't set one. */
export const DEFAULT_PORTAL_OWNER: UserId = "danny";

/** Validate a portal-owner cookie value into a UserId, falling back to the default. */
export function parsePortalOwner(value: string | undefined | null): UserId {
  return USER_IDS.includes(value as UserId) ? (value as UserId) : DEFAULT_PORTAL_OWNER;
}
