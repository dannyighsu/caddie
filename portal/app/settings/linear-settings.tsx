"use client";

import { useState, useEffect } from "react";

/** What GET/POST /api/settings/linear return. Secrets and tokens are never included. */
interface LinearView {
  clientId: string;
  clientSecretSet: boolean;
  webhookSecretSet: boolean;
  configured: boolean;
  connected: { organizationName: string; organizationId: string; appUserId: string; connectedAt: string } | null;
  redirectUrl: string;
  webhookUrl: string | null;
}

const INPUT =
  "w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors";
const LABEL = "block text-xs font-medium text-ink-soft mb-1";
const SAVED_SECRET = "Saved. Leave blank to keep it.";

/**
 * Settings for the Linear agent app: the OAuth app's credentials and webhook
 * secret, then Connect to install it in a workspace. The secrets are
 * write-only: the inputs start empty, and a blank one keeps the stored value.
 */
export function LinearSettings() {
  const [view, setView] = useState<LinearView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function apply(v: LinearView) {
    setView(v);
    setClientId(v.clientId);
    setClientSecret("");
    setWebhookSecret("");
  }

  useEffect(() => {
    // Coming back from the OAuth redirect: show its outcome, then tidy the URL.
    const params = new URLSearchParams(window.location.search);
    if (params.get("linear") === "connected") setNotice("Connected to Linear.");
    const oauthError = params.get("linear_error");
    if (oauthError) setError(`Linear didn't connect: ${oauthError}`);
    if (params.has("linear") || params.has("linear_error")) {
      window.history.replaceState(null, "", window.location.pathname + window.location.hash);
    }

    fetch("/api/settings/linear")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data: LinearView) => apply(data))
      .catch(() => setError("Couldn't load the Linear settings."))
      .finally(() => setLoaded(true));
  }, []);

  function edit(setter: (value: string) => void) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setter(e.target.value);
      setNotice(null);
    };
  }

  async function handleSave() {
    setSaving(true);
    setNotice(null);
    setError(null);
    try {
      const res = await fetch("/api/settings/linear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret, webhookSecret }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setError(data?.error ?? "Couldn't save the Linear settings.");
        return;
      }
      apply(data as LinearView);
      setNotice("Saved");
    } catch {
      setError("Couldn't reach the portal. Try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    if (
      !window.confirm(
        "Remove the Linear settings?\n\nCaddie is disconnected from Linear: mentions stop reaching it and it loses its Linear tools from its next run.",
      )
    ) {
      return;
    }
    setError(null);
    setNotice(null);
    const res = await fetch("/api/settings/linear", { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      setError("Couldn't remove the Linear settings.");
      return;
    }
    const fresh = await fetch("/api/settings/linear").then((r) => r.json()).catch(() => null);
    if (fresh) apply(fresh as LinearView);
  }

  const hasStored = !!view && (view.configured || view.clientSecretSet || view.webhookSecretSet || !!view.clientId);

  return (
    <section id="linear" className="space-y-4">
      <h2 className="text-lg font-semibold">Linear</h2>

      <div className="border border-line bg-surface rounded-xl p-4 shadow-sm space-y-4">
        {!loaded ? (
          <p className="text-sm text-ink-faint">Loading...</p>
        ) : (
          <>
            <div>
              <p className="text-sm text-ink-soft mb-1">
                Mention the agent on a Linear issue, or delegate an issue to it, and it answers in the issue.
              </p>
              {view?.connected ? (
                <p className="text-sm text-good">Connected to {view.connected.organizationName}.</p>
              ) : view?.configured ? (
                <p className="text-sm text-ink-faint">Saved, not connected yet. Connect to install the app in a workspace.</p>
              ) : (
                <p className="text-sm text-ink-faint">Not configured</p>
              )}
            </div>

            {view && (
              <dl className="grid grid-cols-1 gap-2 text-xs">
                <div>
                  <dt className="font-medium text-ink-soft">Callback URL (must match the one in your Linear app)</dt>
                  <dd className="font-mono text-ink break-all">{view.redirectUrl}</dd>
                </div>
                <div>
                  <dt className="font-medium text-ink-soft">Webhook URL (enable Agent session events)</dt>
                  <dd className="font-mono text-ink break-all">
                    {view.webhookUrl ?? "Set PUBLIC_URL in portal/.env.local: Linear can only post to a public address."}
                  </dd>
                </div>
              </dl>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="linear-client-id" className={LABEL}>Client ID</label>
                <input
                  id="linear-client-id"
                  value={clientId}
                  onChange={edit(setClientId)}
                  autoComplete="off"
                  spellCheck={false}
                  className={`${INPUT} font-mono`}
                />
              </div>
              <div>
                <label htmlFor="linear-client-secret" className={LABEL}>Client secret</label>
                <input
                  id="linear-client-secret"
                  type="password"
                  value={clientSecret}
                  onChange={edit(setClientSecret)}
                  placeholder={view?.clientSecretSet ? SAVED_SECRET : ""}
                  autoComplete="new-password"
                  className={INPUT}
                />
              </div>
              <div className="sm:col-span-2">
                <label htmlFor="linear-webhook-secret" className={LABEL}>Webhook signing secret</label>
                <input
                  id="linear-webhook-secret"
                  type="password"
                  value={webhookSecret}
                  onChange={edit(setWebhookSecret)}
                  placeholder={view?.webhookSecretSet ? SAVED_SECRET : ""}
                  autoComplete="new-password"
                  className={INPUT}
                />
              </div>
            </div>

            <p className="text-xs text-ink-faint">
              All three are on the app&apos;s page under Linear Settings → API → Applications. Connecting installs the
              app as its own workspace member, which needs a Linear workspace admin. A team member is recognized by
              their Linear email matching one on the roster; anyone else gets a guest run.
            </p>

            {error && (
              <p role="alert" className="text-sm text-bad">
                {error}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving..." : "Save"}
              </button>
              {view?.configured && (
                <a
                  href="/api/settings/linear/connect"
                  className="px-4 py-2 border border-line-strong rounded-lg text-sm text-ink hover:bg-primary-soft hover:text-primary transition-colors"
                >
                  {view.connected ? "Reconnect" : "Connect to Linear"}
                </a>
              )}
              {hasStored && (
                <button
                  onClick={handleRemove}
                  disabled={saving}
                  className="px-4 py-2 text-bad border border-bad/40 rounded-lg text-sm hover:bg-bad-soft disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  Remove
                </button>
              )}
              {notice && (
                <p role="status" className="text-sm text-good">
                  {notice}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
