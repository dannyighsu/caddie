/**
 * Settings for the `artifacts` capability (publish_artifact), kept in the
 * portal's app_settings instead of the environment. Pure logic: the route,
 * the launcher and the health check do the reads and writes.
 *
 * The password and the R2 secret are write-only. A team run has Bash and can
 * reach this portal on localhost, so nothing here ever puts them in a response:
 * the view says only whether each is set.
 */

export const ARTIFACTS_SETTING_KEY = "artifacts_config";

export interface ArtifactsSettings {
  /** Where the Worker is served, e.g. https://artifacts.example.com */
  origin: string;
  /** The Worker's PW_SHARED secret. */
  password: string;
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** What the settings API returns. */
export interface ArtifactsSettingsView {
  origin: string;
  accountId: string;
  accessKeyId: string;
  passwordSet: boolean;
  secretAccessKeySet: boolean;
  /** All five values are present, so the capability will mount. */
  configured: boolean;
}

const FIELDS = ["origin", "password", "accountId", "accessKeyId", "secretAccessKey"] as const;
const SECRETS = new Set<keyof ArtifactsSettings>(["password", "secretAccessKey"]);

export function viewOf(s: Partial<ArtifactsSettings> | null): ArtifactsSettingsView {
  return {
    origin: s?.origin ?? "",
    accountId: s?.accountId ?? "",
    accessKeyId: s?.accessKeyId ?? "",
    passwordSet: !!s?.password,
    secretAccessKeySet: !!s?.secretAccessKey,
    configured: isComplete(s),
  };
}

function isComplete(s: Partial<ArtifactsSettings> | null): s is ArtifactsSettings {
  return !!s && FIELDS.every((f) => !!s[f]);
}

/**
 * Merge a form submission into the stored settings. A blank secret keeps the
 * stored one, so the form can be saved without retyping either.
 */
export function applyUpdate(
  current: Partial<ArtifactsSettings> | null,
  update: Partial<Record<keyof ArtifactsSettings, unknown>>,
): { settings: ArtifactsSettings } | { error: string } {
  const next: Partial<ArtifactsSettings> = { ...current };
  for (const field of FIELDS) {
    const raw = update[field];
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value) next[field] = value;
    else if (!SECRETS.has(field)) delete next[field];
  }

  if (next.origin) {
    let url: URL;
    try {
      url = new URL(next.origin);
    } catch {
      return { error: "Origin must be a URL, like https://artifacts.example.com." };
    }
    if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash) {
      return { error: "Origin must be an https:// address with no path, like https://artifacts.example.com." };
    }
    next.origin = url.origin;
  }
  if (next.accountId && !/^[0-9a-f]{32}$/.test(next.accountId)) {
    return { error: "The account ID is 32 hex characters (shown by `wrangler whoami`)." };
  }
  // R2's S3 API takes the token's S3 credentials, not the Cloudflare API token
  // itself (cfat_…); pasted there, every upload fails with a bare 400.
  if (next.accessKeyId && !/^[0-9a-f]{32}$/.test(next.accessKeyId)) {
    return {
      error:
        "The R2 access key ID is 32 hex characters. It's the S3 \"Access Key ID\" shown when you create an R2 API token, not the token value (cfat_…).",
    };
  }
  if (next.secretAccessKey && !/^[0-9a-f]{64}$/.test(next.secretAccessKey)) {
    return {
      error:
        "The R2 secret access key is 64 hex characters. It's the S3 \"Secret Access Key\" shown when you create an R2 API token, not the token value (cfat_…).",
    };
  }

  const missing = FIELDS.filter((f) => !next[f]);
  if (missing.length) return { error: `Missing: ${missing.join(", ")}.` };
  return { settings: next as ArtifactsSettings };
}

/**
 * The values harness/capabilities/artifacts.json references. Empty until all
 * five are set, so an incomplete setup leaves the capability unmounted rather
 * than mounted with blanks.
 */
export function capabilityVarsOf(s: Partial<ArtifactsSettings> | null): Record<string, string> {
  if (!isComplete(s)) return {};
  return {
    ARTIFACTS_ORIGIN: s.origin,
    ARTIFACTS_PASSWORD: s.password,
    ARTIFACTS_R2_ACCOUNT_ID: s.accountId,
    ARTIFACTS_R2_ACCESS_KEY_ID: s.accessKeyId,
    ARTIFACTS_R2_SECRET_ACCESS_KEY: s.secretAccessKey,
  };
}
