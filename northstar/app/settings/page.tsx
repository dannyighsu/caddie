"use client";

import { useState, useEffect } from "react";

interface SlackChannel {
  channelId: string;
  channelName?: string;
}

export default function SettingsPage() {
  const [channel, setChannel] = useState<SlackChannel | null>(null);
  const [channelId, setChannelId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    fetch("/api/settings/slack")
      .then((r) => r.json())
      .then((data) => {
        if (data.channel) {
          setChannel(data.channel);
          setChannelId(data.channel.channelId);
          setChannelName(data.channel.channelName ?? "");
        }
        setLoaded(true);
      });
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await fetch("/api/settings/slack", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelId, channelName }),
      });
      setChannel({ channelId, channelName });
    } finally {
      setSaving(false);
    }
  }

  async function handleDisconnect() {
    await fetch("/api/settings/slack", { method: "DELETE" });
    setChannel(null);
    setChannelId("");
    setChannelName("");
  }

  if (!loaded) {
    return <p className="text-gray-500">Loading...</p>;
  }

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold">Settings</h1>

      {/* Slack */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Slack</h2>

        <div className="border border-gray-800 rounded-lg p-4 space-y-4">
          <div>
            <p className="text-sm text-gray-400 mb-1">
              Default channel for agent notifications (check-in results, X Manager digests).
            </p>
            {channel ? (
              <p className="text-sm text-green-400">
                Connected: {channel.channelName || channel.channelId}
              </p>
            ) : (
              <p className="text-sm text-gray-500">Not configured</p>
            )}
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">Channel ID</label>
              <input
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder="C0123456789"
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs text-gray-500 mb-1">
                Channel Name (optional)
              </label>
              <input
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder="#general"
                className="w-full bg-gray-900 border border-gray-700 rounded px-3 py-2 text-sm focus:outline-none focus:border-gray-500"
              />
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving || !channelId.trim()}
              className="px-4 py-2 bg-white text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {channel && (
              <button
                onClick={handleDisconnect}
                className="px-4 py-2 text-red-400 border border-red-800 rounded-lg text-sm hover:bg-red-950 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Environment Status */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Environment</h2>
        <div className="border border-gray-800 rounded-lg p-4">
          <div className="space-y-2 text-sm">
            <EnvStatus name="SLACK_BOT_TOKEN" />
            <EnvStatus name="SLACK_SIGNING_SECRET" />
            <EnvStatus name="KV_REST_API_URL" label="Redis" />
            <EnvStatus name="POSTGRES_URL" label="Postgres" />
            <EnvStatus name="GOOGLE_CLIENT_ID" label="Google Calendar" />
          </div>
        </div>
      </section>
    </div>
  );
}

function EnvStatus({ name, label }: { name: string; label?: string }) {
  // We can't read env vars client-side — this is a static display
  // In a real implementation, we'd have an API endpoint for this
  return (
    <div className="flex items-center justify-between">
      <span className="text-gray-400">{label ?? name}</span>
      <span className="text-xs text-gray-600">Set in .env.local</span>
    </div>
  );
}
