"use client";

import { useState, useEffect } from "react";
import { TeamRoster } from "./team-roster";
import { ArtifactsSettings } from "./artifacts-settings";
import { LinearSettings } from "./linear-settings";

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
    return <p className="text-ink-faint">Loading...</p>;
  }

  return (
    <div className="space-y-10">
      <h1 className="text-2xl font-semibold">Settings</h1>

      <TeamRoster />

      {/* Slack */}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Slack</h2>

        <div className="border border-line bg-surface rounded-xl p-4 shadow-sm space-y-4">
          <div>
            <p className="text-sm text-ink-soft mb-1">
              Default channel for agent notifications (check-in results, X Manager digests).
            </p>
            {channel ? (
              <p className="text-sm text-good">
                Connected: {channel.channelName || channel.channelId}
              </p>
            ) : (
              <p className="text-sm text-ink-faint">Not configured</p>
            )}
          </div>

          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-ink-soft mb-1">Channel ID</label>
              <input
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder="C0123456789"
                className="w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors"
              />
            </div>
            <div className="flex-1">
              <label className="block text-xs font-medium text-ink-soft mb-1">
                Channel Name (optional)
              </label>
              <input
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder="#general"
                className="w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors"
              />
            </div>
          </div>

          <div className="flex gap-3">
            <button
              onClick={handleSave}
              disabled={saving || !channelId.trim()}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {channel && (
              <button
                onClick={handleDisconnect}
                className="px-4 py-2 text-bad border border-bad/40 rounded-lg text-sm hover:bg-bad-soft transition-colors"
              >
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      {/* Artifacts */}
      <ArtifactsSettings />

      {/* Linear */}
      <LinearSettings />

      {/* Schedules */}
      <Schedules />

      {/* Capabilities Health */}
      <CapabilitiesHealth />
    </div>
  );
}

// =============================================================================
// Schedules
// =============================================================================

interface Job {
  id: string;
  profile?: string;
  cron?: string;
  nextRun: number;
  enabled: boolean;
  description?: string;
  params?: Record<string, unknown>;
}

function Schedules() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false);

  // New job form
  const [profile, setProfile] = useState("");
  const [cron, setCron] = useState("");
  const [prompt, setPrompt] = useState("");
  const [description, setDescription] = useState("");
  const [creating, setCreating] = useState(false);

  function refreshJobs() {
    fetch("/api/control")
      .then((r) => r.json())
      .then((data) => {
        setJobs(data.jobs ?? []);
        setLoaded(true);
      });
  }

  useEffect(() => {
    refreshJobs();
  }, []);

  async function handleCreate() {
    if (!cron.trim()) return;
    setCreating(true);
    try {
      await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "schedule",
          profile: profile || undefined,
          cron,
          prompt: prompt || undefined,
          description: description || undefined,
        }),
      });
      setCron("");
      setPrompt("");
      setDescription("");
      refreshJobs();
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(jobId: string) {
    await fetch("/api/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "schedule", jobId }),
    });
    refreshJobs();
  }

  const [running, setRunning] = useState<string | null>(null);

  async function handleRunNow(job: Job) {
    const sideEffects =
      "If this job has side effects (sending email, posting, creating events), running it now may duplicate them";
    const tail = job.cron
      ? " in addition to its scheduled runs."
      : ", and it will then be removed from the schedule (it won't fire at its scheduled time).";
    if (!window.confirm(`Run "${job.description ?? job.id}" now?\n\n${sideEffects}${tail}`)) {
      return;
    }

    setRunning(job.id);
    try {
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "trigger", jobId: job.id }),
      });
      const data = await res.json();
      if (!data.success) {
        window.alert(data.error ?? "Failed to run job.");
      } else if (data.started) {
        window.alert("Run started — watch the transcripts for output.");
      }
      refreshJobs();
    } finally {
      setRunning(null);
    }
  }

  function formatNextRun(epochMs: number): string {
    const d = new Date(epochMs);
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
    const diffMin = Math.round(diffMs / 60000);

    if (diffMin < 0) return "overdue";
    if (diffMin < 1) return "now";
    if (diffMin < 60) return `in ${diffMin}m`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `in ${diffHr}h`;
    return d.toLocaleDateString();
  }

  return (
    <section className="space-y-4">
      <h2 className="text-lg font-semibold">Schedules</h2>

      {/* Active jobs */}
      <div className="border border-line bg-surface rounded-xl p-4 shadow-sm">
        {!loaded ? (
          <p className="text-sm text-ink-faint">Loading...</p>
        ) : jobs.length === 0 ? (
          <p className="text-sm text-ink-faint">No scheduled jobs.</p>
        ) : (
          <div className="space-y-2">
            {jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between text-sm border-b border-line pb-2 last:border-0 last:pb-0"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">
                      {job.profile ?? "default"}
                    </span>
                    {job.cron && (
                      <span className="text-xs font-mono text-ink-faint">{job.cron}</span>
                    )}
                    {!job.cron && (
                      <span className="text-xs text-ink-faint">one-shot</span>
                    )}
                  </div>
                  {job.description && (
                    <p className="text-xs text-ink-faint mt-0.5">{job.description}</p>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <span className={`text-xs ${job.enabled ? "text-good" : "text-ink-faint"}`}>
                    {job.enabled ? formatNextRun(job.nextRun) : "disabled"}
                  </span>
                  <button
                    onClick={() => handleRunNow(job)}
                    disabled={running === job.id}
                    className="text-xs text-ink-faint hover:text-good transition-colors disabled:opacity-50"
                  >
                    {running === job.id ? "running..." : "run now"}
                  </button>
                  <button
                    onClick={() => handleDelete(job.id)}
                    className="text-xs text-ink-faint hover:text-bad transition-colors"
                  >
                    delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* New job form */}
      <div className="border border-line bg-surface rounded-xl p-4 shadow-sm space-y-3">
        <p className="text-sm text-ink-soft">Create a recurring schedule</p>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1">Profile</label>
            <input
              value={profile}
              onChange={(e) => setProfile(e.target.value)}
              placeholder="e.g. extended"
              className="w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1">Cron</label>
            <input
              value={cron}
              onChange={(e) => setCron(e.target.value)}
              placeholder="0,30 * * * *"
              className="w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm font-mono text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-soft mb-1">Prompt</label>
            <input
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="/feed-scan"
              className="w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-ink-soft mb-1">Description</label>
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Feed scan every 30 min"
            className="w-full bg-surface-muted border border-line-strong rounded-lg px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:border-primary focus:bg-surface transition-colors"
          />
        </div>
        <button
          onClick={handleCreate}
          disabled={creating || !cron.trim()}
          className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {creating ? "Creating..." : "Create Schedule"}
        </button>
      </div>
    </section>
  );
}

// =============================================================================
// Capabilities Health
// =============================================================================

interface HealthResult {
  name: string;
  type: "mcp" | "flag";
  status: "ok" | "error" | "skipped";
  message?: string;
  durationMs?: number;
}

function CapabilitiesHealth() {
  const [results, setResults] = useState<HealthResult[]>([]);
  const [checking, setChecking] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function runChecks() {
    setChecking(true);
    try {
      const res = await fetch("/api/health");
      setResults(await res.json());
      setLoaded(true);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    runChecks();
  }, []);

  const statusColor = {
    ok: "text-good font-semibold",
    error: "text-bad font-semibold",
    skipped: "text-ink-faint",
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Capabilities</h2>
        <button
          onClick={runChecks}
          disabled={checking}
          className="text-xs px-3 py-1 bg-surface-muted text-ink-soft rounded hover:bg-primary-soft hover:text-primary disabled:opacity-40 transition-colors"
        >
          {checking ? "Checking..." : "Re-check"}
        </button>
      </div>
      <div className="border border-line bg-surface rounded-xl p-4 shadow-sm">
        {!loaded ? (
          <p className="text-sm text-ink-faint">Running health checks...</p>
        ) : results.length === 0 ? (
          <p className="text-sm text-ink-faint">No capabilities configured.</p>
        ) : (
          <div className="space-y-2">
            {results.map((r) => (
              <div key={r.name} className="flex items-center justify-between text-sm">
                <div className="flex items-center gap-2">
                  <span className={statusColor[r.status]}>
                    {r.status === "ok" ? "ok" : r.status === "error" ? "err" : "skip"}
                  </span>
                  <span className="text-ink">{r.name}</span>
                  <span className="text-xs text-ink-faint">{r.type}</span>
                </div>
                <div className="flex items-center gap-2">
                  {r.message && (
                    <span className="text-xs text-ink-faint truncate max-w-xs">
                      {r.message}
                    </span>
                  )}
                  {r.durationMs !== undefined && (
                    <span className="text-xs text-ink-faint">{r.durationMs}ms</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
