"use client";

import { useState, useEffect, useCallback } from "react";

type RunStatus = "running" | "succeeded" | "failed" | "skipped";
type FailureClass =
  | "api"
  | "agent"
  | "orchestration"
  | "orphaned"
  | "dropped"
  | null;

interface RunSummary {
  id: string;
  replay_of: string | null;
  source: "inbound" | "scheduler" | "trigger" | "portal";
  profile: string | null;
  label: string | null;
  status: RunStatus;
  failure_class: FailureClass;
  error: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  deliversTo: string;
}

type Filter = "failed" | "all" | "active";

const FAILURE_LABELS: Record<string, string> = {
  api: "API layer",
  agent: "Agent error",
  orchestration: "Orchestration",
  orphaned: "Crashed / hung",
  dropped: "Dropped",
};

const SOURCE_LABELS: Record<string, string> = {
  inbound: "Inbound message",
  scheduler: "Scheduled",
  trigger: "Triggered",
  portal: "Portal run",
};

export default function RunsPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("failed");
  const [replaying, setReplaying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/runs?status=${filter}`)
      .then((r) => r.json())
      .then((data) => setRuns(Array.isArray(data) ? data : []))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  async function replay(run: RunSummary) {
    const confirmed = window.confirm(
      `Replay this run live?\n\n` +
        `${run.label ?? run.source}\n\n` +
        `This re-runs the agent and ${run.deliversTo}. ` +
        `It may re-send real messages.`
    );
    if (!confirmed) return;

    setReplaying(run.id);
    setNotice(null);
    try {
      const res = await fetch(`/api/runs/${run.id}/replay`, { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        setNotice(`Replayed — new run ${String(data.runId).substring(0, 8)} started.`);
        load();
      } else {
        setNotice(`Replay failed: ${data.error ?? "unknown error"}`);
      }
    } catch (err) {
      setNotice(`Replay failed: ${err instanceof Error ? err.message : "unknown error"}`);
    } finally {
      setReplaying(null);
    }
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    const diffMin = Math.floor((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    const diffDays = Math.floor(diffHr / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  }

  function statusBadge(run: RunSummary) {
    if (run.status === "failed") {
      const label = run.failure_class ? FAILURE_LABELS[run.failure_class] ?? "Failed" : "Failed";
      return (
        <span className="rounded-full bg-red-500/15 text-red-600 px-2 py-0.5 text-xs font-medium">
          {label}
        </span>
      );
    }
    if (run.status === "running") {
      return (
        <span className="rounded-full bg-amber-500/15 text-amber-600 px-2 py-0.5 text-xs font-medium">
          Running
        </span>
      );
    }
    if (run.status === "skipped") {
      return (
        <span className="rounded-full bg-slate-500/15 text-ink-faint px-2 py-0.5 text-xs font-medium">
          Skipped
        </span>
      );
    }
    return (
      <span className="rounded-full bg-emerald-500/15 text-emerald-600 px-2 py-0.5 text-xs font-medium">
        Succeeded
      </span>
    );
  }

  const filters: { key: Filter; label: string }[] = [
    { key: "failed", label: "Failed" },
    { key: "active", label: "Running" },
    { key: "all", label: "All" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <span className="h-4 w-1.5 rounded-full bg-accent" />
          Runs
        </h1>
        <div className="flex items-center gap-1">
          {filters.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              className={`text-sm rounded-md px-3 py-1.5 transition-colors ${
                filter === f.key
                  ? "bg-primary-soft text-primary font-medium"
                  : "text-ink-soft hover:text-primary hover:bg-primary-soft"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <p className="text-sm text-ink-faint">
        Every agent job — inbound message, scheduled, triggered, or portal run —
        is recorded here for 7 days. Replay re-runs a job live from its original
        inputs.
      </p>

      {notice && (
        <div className="rounded-lg border border-line bg-surface px-4 py-2.5 text-sm text-ink-soft">
          {notice}
        </div>
      )}

      {loading ? (
        <p className="text-ink-faint">Loading...</p>
      ) : runs.length === 0 ? (
        <p className="text-ink-faint">
          {filter === "failed" ? "No failed runs. 🎉" : "No runs found."}
        </p>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <div
              key={run.id}
              className="border border-line bg-surface rounded-xl p-4 shadow-sm"
            >
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0 space-y-1.5">
                  <div className="flex items-center gap-2 flex-wrap">
                    {statusBadge(run)}
                    <span className="text-xs text-ink-faint">
                      {SOURCE_LABELS[run.source] ?? run.source}
                    </span>
                    {run.replay_of && (
                      <span className="text-xs text-ink-faint italic">· replay</span>
                    )}
                    <span className="text-xs text-ink-faint">
                      · {formatTime(run.created_at)}
                    </span>
                  </div>
                  <div className="text-sm text-ink font-medium truncate">
                    {run.label ?? `${run.source}${run.profile ? `:${run.profile}` : ""}`}
                  </div>
                  {run.error && (
                    <div className="text-xs text-ink-faint font-mono line-clamp-2 break-words">
                      {run.error}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => replay(run)}
                  disabled={replaying === run.id || run.status === "running"}
                  className="shrink-0 text-sm rounded-lg border border-line bg-canvas px-3 py-1.5 text-primary hover:border-primary hover:bg-primary-soft transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  title={run.deliversTo}
                >
                  {replaying === run.id ? "Replaying…" : "Replay"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
