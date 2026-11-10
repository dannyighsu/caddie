"use client";

import { useState, useEffect } from "react";

/** What GET/POST /api/settings/artifacts return. The two secrets are never included. */
interface ArtifactsView {
  origin: string;
  accountId: string;
  accessKeyId: string;
  passwordSet: boolean;
  secretAccessKeySet: boolean;
  configured: boolean;
}

const INPUT =
  "w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors";
const LABEL = "block text-xs font-medium text-ink-soft mb-1";
const SAVED_SECRET = "Saved. Leave blank to keep it.";

/**
 * Settings for the agent's publish_artifact capability. The shared password and
 * the R2 secret are write-only: the inputs start empty, and a blank one keeps
 * the stored value.
 */
export function ArtifactsSettings() {
  const [view, setView] = useState<ArtifactsView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [origin, setOrigin] = useState("");
  const [password, setPassword] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function apply(v: ArtifactsView) {
    setView(v);
    setOrigin(v.origin);
    setAccountId(v.accountId);
    setAccessKeyId(v.accessKeyId);
    setPassword("");
    setSecretAccessKey("");
  }

  useEffect(() => {
    fetch("/api/settings/artifacts")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: ArtifactsView) => apply(data))
      .catch(() => setError("Couldn't load the artifacts settings."))
      .finally(() => setLoaded(true));
  }, []);

  /** Wraps a setter so editing any field clears the last save/error message. */
  function edit(setter: (value: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      setSaved(false);
    };
  }

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch("/api/settings/artifacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ origin, password, accountId, accessKeyId, secretAccessKey }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setError(data?.error ?? "Couldn't save the artifacts settings.");
        return;
      }
      apply(data as ArtifactsView);
      setSaved(true);
    } catch {
      setError("Couldn't reach the portal. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (
      !window.confirm(
        "Remove the artifacts settings?\n\nThe agent loses publish_artifact from its next run. Artifacts already published stay where they are.",
      )
    ) {
      return;
    }
    setError(null);
    setSaved(false);
    const res = await fetch("/api/settings/artifacts", { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setError("Couldn't remove the artifacts settings.");
      return;
    }
    apply({ origin: "", accountId: "", accessKeyId: "", passwordSet: false, secretAccessKeySet: false, configured: false });
  }

  const hasStored =
    !!view && (view.configured || view.passwordSet || view.secretAccessKeySet || !!view.origin || !!view.accountId || !!view.accessKeyId);

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Artifacts</h2>

      <div className="border border-line bg-surface rounded-xl p-4 shadow-sm space-y-4">
        {!loaded ? (
          <p className="text-sm text-ink-faint">Loading...</p>
        ) : (
          <>
            <div>
              <p className="text-sm text-ink-soft mb-1">
                Lets the agent publish pages behind a shared password with publish_artifact.
              </p>
              {view?.configured ? (
                <p className="text-sm text-good">
                  Configured: the agent gets publish_artifact from its next run, no restart needed.
                </p>
              ) : (
                <p className="text-sm text-ink-faint">Not configured</p>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="artifacts-origin" className={LABEL}>Origin</label>
                <input
                  id="artifacts-origin"
                  type="url"
                  value={origin}
                  onChange={edit(setOrigin)}
                  placeholder="https://artifacts.example.com"
                  autoComplete="off"
                  spellCheck={false}
                  className={INPUT}
                />
              </div>
              <div>
                <label htmlFor="artifacts-password" className={LABEL}>Shared password</label>
                <input
                  id="artifacts-password"
                  type="password"
                  value={password}
                  onChange={edit(setPassword)}
                  placeholder={view?.passwordSet ? SAVED_SECRET : ""}
                  autoComplete="new-password"
                  className={INPUT}
                />
              </div>
              <div>
                <label htmlFor="artifacts-account-id" className={LABEL}>Cloudflare account ID</label>
                <input
                  id="artifacts-account-id"
                  value={accountId}
                  onChange={edit(setAccountId)}
                  placeholder="32 hex characters"
                  autoComplete="off"
                  spellCheck={false}
                  className={`${INPUT} font-mono`}
                />
              </div>
              <div>
                <label htmlFor="artifacts-access-key-id" className={LABEL}>R2 access key ID</label>
                <input
                  id="artifacts-access-key-id"
                  value={accessKeyId}
                  onChange={edit(setAccessKeyId)}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${INPUT} font-mono`}
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="artifacts-secret-access-key" className={LABEL}>R2 secret access key</label>
                <input
                  id="artifacts-secret-access-key"
                  type="password"
                  value={secretAccessKey}
                  onChange={edit(setSecretAccessKey)}
                  placeholder={view?.secretAccessKeySet ? SAVED_SECRET : ""}
                  autoComplete="new-password"
                  className={INPUT}
                />
              </div>
            </div>

            <p className="text-xs text-ink-faint">
              The password is the Worker&apos;s PW_SHARED secret. The R2 token needs Object Read &amp; Write
              on the caddie-artifacts bucket. Enter its S3 Access Key ID and Secret Access Key, not the
              token value (cfat_…).
            </p>

            {error && (
              <p role="alert" className="text-sm text-bad">
                {error}
              </p>
            )}

            <div className="flex items-center gap-3">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              {hasStored && (
                <button
                  onClick={handleRemove}
                  disabled={saving}
                  className="px-4 py-2 text-bad border border-bad/40 rounded-lg text-sm hover:bg-bad-soft disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Remove
                </button>
              )}
              {saved && (
                <p role="status" className="text-sm text-good">
                  Saved
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
