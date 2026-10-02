"use client";

import { useState, useEffect } from "react";
import Link from "next/link";

interface Transcript {
  sessionId: string;
  size: number;
  modified: string;
}

export default function TranscriptsPage() {
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/transcripts")
      .then((r) => r.json())
      .then(setTranscripts)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-ink-faint">Loading...</p>;

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    const diffHr = Math.floor(diffMin / 60);
    const diffDays = Math.floor(diffHr / 24);

    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffHr < 24) return `${diffHr}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-xl font-semibold">
          <span className="h-4 w-1.5 rounded-full bg-accent" />
          Traces
        </h1>
        <span className="text-sm text-ink-faint">{transcripts.length} sessions</span>
      </div>

      {transcripts.length === 0 ? (
        <p className="text-ink-faint">No transcripts found.</p>
      ) : (
        <div className="space-y-2">
          {transcripts.map((t) => (
            <Link
              key={t.sessionId}
              href={`/transcripts/${t.sessionId}`}
              className="block border border-line bg-surface rounded-xl p-3 shadow-sm hover:border-primary hover:shadow-md transition-all"
            >
              <div className="flex items-center justify-between text-sm">
                <span className="font-mono text-primary">
                  {t.sessionId.substring(0, 12)}...
                </span>
                <div className="flex items-center gap-3 text-ink-faint">
                  <span>{formatSize(t.size)}</span>
                  <span>{formatTime(t.modified)}</span>
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
