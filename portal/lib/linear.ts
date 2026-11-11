/**
 * Linear client: the OAuth install, token refresh, and the few GraphQL calls
 * the portal makes itself (agent activities). The agent's own Linear tools come
 * from Linear's hosted MCP, mounted by the `linear` capability with the token
 * `linearAccessToken()` returns.
 *
 * App-actor tokens from the authorization-code grant last 24 hours and must be
 * refreshed; the refresh token lasts 30 days from its last use. One portal
 * process owns the tokens, so a single in-flight refresh is enough
 * coordination.
 */

import { teamLookup } from "@caddie/harness";
import { getSetting, setSetting } from "./db";
import { teamRoster } from "./team";
import type { ResolvedIdentity } from "./identity";
import type { LinearUser } from "./linear-webhook";
import {
  LINEAR_SETTING_KEY,
  type LinearInstallation,
  type LinearSettings,
} from "./linear-settings";

const API_URL = "https://api.linear.app/graphql";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REVOKE_URL = "https://api.linear.app/oauth/revoke";

/**
 * Refresh this long before expiry. A run gets the token once, at launch, and
 * can last hours, so the token it's handed must outlive it.
 */
const REFRESH_MARGIN_MS = 6 * 60 * 60 * 1000;
/** Without a run, refresh this often anyway so the 30-day refresh token never lapses. */
const KEEPALIVE_INTERVAL_MS = 12 * 60 * 60 * 1000;

export function loadLinearSettings(): Promise<LinearSettings | null> {
  return getSetting<LinearSettings>(LINEAR_SETTING_KEY);
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
  const data = (await res.json().catch(() => null)) as (TokenResponse & { error_description?: string; error?: string }) | null;
  if (!res.ok || !data?.access_token) {
    throw new Error(`Linear token request failed (${res.status}): ${data?.error_description ?? data?.error ?? "no token"}`);
  }
  return data;
}

function expiresAtOf(t: TokenResponse): number {
  return Date.now() + (t.expires_in ?? 24 * 60 * 60) * 1000;
}

/** A GraphQL call with an explicit token. Throws on HTTP or GraphQL errors. */
async function graphql<T>(token: string, query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = (await res.json().catch(() => null)) as { data?: T; errors?: { message: string }[] } | null;
  if (!res.ok || !body || body.errors?.length || !body.data) {
    const why = body?.errors?.map((e) => e.message).join("; ") ?? `HTTP ${res.status}`;
    throw new Error(`Linear API error: ${why}`);
  }
  return body.data;
}

/**
 * Finish the install: trade the code for tokens, learn which workspace and app
 * user they belong to, and store the installation.
 */
export async function completeInstall(
  settings: LinearSettings,
  code: string,
  redirectUri: string,
): Promise<LinearInstallation> {
  const tokens = await tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
  });
  if (!tokens.refresh_token) throw new Error("Linear returned no refresh token.");

  const me = await graphql<{ viewer: { id: string }; organization: { id: string; name: string } }>(
    tokens.access_token,
    `query { viewer { id } organization { id name } }`,
  );

  const installation: LinearInstallation = {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: expiresAtOf(tokens),
    appUserId: me.viewer.id,
    organizationId: me.organization.id,
    organizationName: me.organization.name,
    connectedAt: new Date().toISOString(),
  };
  // Re-read so a settings save that landed during the round trip isn't undone.
  const latest = (await loadLinearSettings()) ?? settings;
  await setSetting<LinearSettings>(LINEAR_SETTING_KEY, { ...latest, installation });
  return installation;
}

let refreshing: Promise<string> | null = null;

async function refresh(settings: LinearSettings & { installation: LinearInstallation }): Promise<string> {
  const tokens = await tokenRequest({
    grant_type: "refresh_token",
    refresh_token: settings.installation.refreshToken,
    client_id: settings.clientId,
    client_secret: settings.clientSecret,
  });
  const latest = (await loadLinearSettings()) ?? settings;
  if (!latest.installation) throw new Error("Linear was disconnected during a token refresh.");
  const installation: LinearInstallation = {
    ...latest.installation,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? latest.installation.refreshToken,
    expiresAt: expiresAtOf(tokens),
  };
  await setSetting<LinearSettings>(LINEAR_SETTING_KEY, { ...latest, installation });
  console.log(`[Linear] Refreshed access token (expires ${new Date(installation.expiresAt).toISOString()})`);
  return installation.accessToken;
}

/**
 * A valid app-actor access token, refreshed if it's near expiry. Null when
 * Linear isn't connected.
 */
export async function linearAccessToken(): Promise<string | null> {
  const s = await loadLinearSettings();
  if (!s?.installation) return null;
  if (s.installation.expiresAt - Date.now() > REFRESH_MARGIN_MS) return s.installation.accessToken;
  refreshing ??= refresh(s as LinearSettings & { installation: LinearInstallation }).finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/** Keep the refresh token alive on an install that goes quiet for weeks. */
export function startLinearTokenKeepalive(): void {
  const tick = () =>
    linearAccessToken().catch((err) => console.error("[Linear] Token refresh failed:", err));
  tick();
  setInterval(tick, KEEPALIVE_INTERVAL_MS).unref?.();
}

/** Best-effort revoke of the stored install's tokens. Never throws. */
export async function revokeInstall(settings: LinearSettings | null): Promise<void> {
  const inst = settings?.installation;
  if (!settings || !inst) return;
  try {
    const res = await fetch(REVOKE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${settings.clientId}:${settings.clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({ token: inst.refreshToken, token_type_hint: "refresh_token" }).toString(),
    });
    if (!res.ok) console.warn(`[Linear] Revoke returned ${res.status}; remove the app in Linear if it's still installed.`);
  } catch (err) {
    console.warn("[Linear] Revoke failed:", err);
  }
}

// --- Agent activities ---

export type AgentActivityContent =
  | { type: "thought" | "response" | "error" | "elicitation"; body: string }
  | { type: "action"; action: string; parameter: string; result?: string };

/** Post an activity into an agent session, as the app. */
export async function createAgentActivity(
  agentSessionId: string,
  content: AgentActivityContent,
  opts: { ephemeral?: boolean } = {},
): Promise<void> {
  const token = await linearAccessToken();
  if (!token) throw new Error("Linear is not connected.");
  const data = await graphql<{ agentActivityCreate: { success: boolean } }>(
    token,
    `mutation ($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success } }`,
    { input: { agentSessionId, content, ...(opts.ephemeral ? { ephemeral: true } : {}) } },
  );
  if (!data.agentActivityCreate.success) throw new Error("Linear rejected the agent activity.");
}

// --- Identity ---

/**
 * Resolve a Linear user against the team roster by email. Linear accounts sign
 * in by email or SSO, and the event is only accepted from the workspace that
 * installed the app (checked upstream), so a matching email is treated as that
 * team member.
 */
export function resolveLinearIdentity(user: LinearUser | null): ResolvedIdentity {
  if (!user?.email) return { kind: "guest", channel: "linear", rawSender: user?.id ?? "unknown" };
  const rawSender = user.email.toLowerCase();
  const userId = teamLookup(teamRoster(), "emails").get(rawSender);
  return userId
    ? { kind: "authenticated", userId, channel: "linear", rawSender }
    : { kind: "guest", channel: "linear", rawSender };
}
