/**
 * Settings for the Linear integration, kept in the portal's app_settings.
 * Pure logic: the routes, the Linear client and the launcher do the reads and
 * writes.
 *
 * Two halves live under one key:
 *   - what the team enters in Settings → Linear: the OAuth app's client ID and
 *     secret, and the webhook signing secret;
 *   - the installation the OAuth redirect stores: the app-actor tokens and the
 *     workspace they belong to.
 *
 * Secrets and tokens are write-only. A team run has Bash and can reach this
 * portal on localhost, so nothing here ever puts them in a response: the view
 * says only whether each is set.
 */

export const LINEAR_SETTING_KEY = "linear_config";
/** The in-flight OAuth request, between Connect and the redirect back. */
export const LINEAR_OAUTH_PENDING_KEY = "linear_oauth_pending";

/** Where Linear sends the browser back after install. Must match the app's callback URL. */
export const LINEAR_REDIRECT_PATH = "/api/chat/plugins/linear/oauth_redirect";
/** Where Linear posts agent session events. */
export const LINEAR_WEBHOOK_PATH = "/api/chat/plugins/linear/webhook";

/**
 * `app:mentionable` and `app:assignable` make the app a workspace member you can
 * @mention or delegate an issue to; `read,write` cover the MCP's tools.
 */
export const LINEAR_SCOPES = ["read", "write", "app:assignable", "app:mentionable"];

/** A pending OAuth request older than this is refused. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface LinearInstallation {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
  /** The app's user id in this workspace (the "Caddie" member). */
  appUserId: string;
  organizationId: string;
  organizationName: string;
  connectedAt: string;
}

export interface LinearSettings {
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  installation?: LinearInstallation;
}

export interface LinearOAuthPending {
  state: string;
  /** The redirect_uri sent to Linear; the token exchange must repeat it. */
  redirectUri: string;
  /** Origin of the portal page that started Connect, to send the browser back to. */
  returnTo: string;
  createdAt: number;
}

/** What the settings API returns. */
export interface LinearSettingsView {
  clientId: string;
  clientSecretSet: boolean;
  webhookSecretSet: boolean;
  /** Client ID, client secret and webhook secret are all present. */
  configured: boolean;
  connected: {
    organizationName: string;
    organizationId: string;
    appUserId: string;
    connectedAt: string;
  } | null;
  /** The callback URL Connect sends to Linear. */
  redirectUrl: string;
  /** The webhook URL to give Linear, or null when PUBLIC_URL isn't set. */
  webhookUrl: string | null;
}

const FIELDS = ["clientId", "clientSecret", "webhookSecret"] as const;
type Field = (typeof FIELDS)[number];
const SECRETS = new Set<Field>(["clientSecret", "webhookSecret"]);

/** The origin of PUBLIC_URL, or null when it's unset or not a URL. */
export function publicOrigin(publicUrl: string | undefined): string | null {
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl).origin;
  } catch {
    return null;
  }
}

/**
 * The redirect URI for Connect. Linear has to reach the portal from the
 * browser, so it's the public URL when there is one, else wherever the portal
 * is being viewed from.
 */
export function redirectUriFor(publicUrl: string | undefined, requestOrigin: string): string {
  return `${publicOrigin(publicUrl) ?? requestOrigin}${LINEAR_REDIRECT_PATH}`;
}

/** Linear can only post to a public URL, so there's no webhook URL without one. */
export function webhookUrlFor(publicUrl: string | undefined): string | null {
  const origin = publicOrigin(publicUrl);
  return origin ? `${origin}${LINEAR_WEBHOOK_PATH}` : null;
}

export function isConfigured(s: Partial<LinearSettings> | null): s is LinearSettings {
  return !!s && FIELDS.every((f) => !!s[f]);
}

export function viewOf(
  s: Partial<LinearSettings> | null,
  urls: { publicUrl: string | undefined; requestOrigin: string },
): LinearSettingsView {
  const inst = s?.installation;
  return {
    clientId: s?.clientId ?? "",
    clientSecretSet: !!s?.clientSecret,
    webhookSecretSet: !!s?.webhookSecret,
    configured: isConfigured(s),
    connected: inst
      ? {
          organizationName: inst.organizationName,
          organizationId: inst.organizationId,
          appUserId: inst.appUserId,
          connectedAt: inst.connectedAt,
        }
      : null,
    redirectUrl: redirectUriFor(urls.publicUrl, urls.requestOrigin),
    webhookUrl: webhookUrlFor(urls.publicUrl),
  };
}

/**
 * Merge a form submission into the stored settings. A blank secret keeps the
 * stored one, so the form can be saved without retyping either. Changing the
 * client ID drops the installation: its tokens belong to the old app.
 */
export function applyUpdate(
  current: Partial<LinearSettings> | null,
  update: Partial<Record<Field, unknown>>,
): { settings: LinearSettings } | { error: string } {
  const next: Partial<LinearSettings> = { ...current };
  for (const field of FIELDS) {
    const raw = update[field];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) next[field] = value;
    else if (!SECRETS.has(field)) delete next[field];
  }

  if (current?.clientId && next.clientId !== current.clientId) {
    delete next.installation;
  }

  const missing = FIELDS.filter((f) => !next[f]);
  if (missing.length) return { error: `Missing: ${missing.map(labelOf).join(", ")}.` };
  return { settings: next as LinearSettings };
}

function labelOf(field: Field): string {
  return { clientId: "client ID", clientSecret: "client secret", webhookSecret: "webhook signing secret" }[field];
}

/** The URL Connect sends the browser to, installing the app as itself (actor=app). */
export function authorizeUrl(params: { clientId: string; redirectUri: string; state: string }): string {
  const url = new URL("https://linear.app/oauth/authorize");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", LINEAR_SCOPES.join(","));
  url.searchParams.set("state", params.state);
  url.searchParams.set("actor", "app");
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

/** Whether a pending OAuth request matches the state Linear sent back and is still fresh. */
export function pendingMatches(
  pending: LinearOAuthPending | null,
  state: string | null,
  now: number,
): pending is LinearOAuthPending {
  return !!pending && !!state && pending.state === state && now - pending.createdAt <= OAUTH_STATE_TTL_MS;
}
