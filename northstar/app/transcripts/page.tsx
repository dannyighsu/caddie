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
    fetch("/api/transcripts?agentId=buri")
      .then((r) => r.json())
      .then(setTranscripts)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-gray-500">Loading...</p>;

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
        <h1 className="text-xl font-semibold">Traces</h1>
        <span className="text-sm text-gray-500">{transcripts.length} sessions</span>
      </div>

      {transcripts.length === 0 ? (
        <p className="text-gray-500">No transcripts found.</p>
      ) : (
        <div className="space-y-2">
          {transcripts.map((t) => (
            <Link
              key={t.sessionId}
              href={`/transcripts/${t.sessionId}?agentId=buri`}
              className="block border border-gray-800 rounded-lg p-3 hover:border-gray-600 transition-colors"
            >
              <div className="flex items-center justify-between text-sm">
                <span className="font-mono text-gray-300">
                  {t.sessionId.substring(0, 12)}...
                </span>
                <div className="flex items-center gap-3 text-gray-500">
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
