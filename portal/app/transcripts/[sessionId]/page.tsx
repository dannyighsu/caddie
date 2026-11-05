"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";

interface TranscriptStep {
  role: "assistant" | "user" | "system";
  type: "text" | "tool_use" | "tool_result" | "thinking" | "progress";
  content: string;
  toolName?: string;
  /** True when the step came from a subagent conversation, not the parent run. */
  sidechain?: boolean;
}

export default function TranscriptPage() {
  const params = useParams<{ sessionId: string }>();

  const [steps, setSteps] = useState<TranscriptStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/transcripts/${params.sessionId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setSteps(data.steps ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [params.sessionId]);

  if (loading) return <p className="text-ink-faint">Loading transcript...</p>;
  if (error) return <p className="text-bad">Error: {error}</p>;

  const typeStyles: Record<string, string> = {
    text: "bg-surface border border-line text-ink shadow-sm",
    tool_use: "bg-primary-soft text-primary border-l-2 border-primary",
    tool_result: "bg-surface-muted text-ink-soft border-l-2 border-line-strong",
    thinking: "bg-[#f3edfb] text-[#6d4aa8] border-l-2 border-[#b499dd]",
  };

  const typeLabels: Record<string, string> = {
    text: "",
    tool_use: "tool call",
    tool_result: "result",
    thinking: "thinking",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <span className="h-4 w-1.5 rounded-full bg-accent" />
            Transcript
          </h1>
          <p className="text-xs text-ink-faint mt-1">
            Session: {params.sessionId.substring(0, 12)}...
          </p>
        </div>
        <span className="text-xs text-ink-faint">{steps.length} steps</span>
      </div>

      <div className="space-y-2">
        {steps.map((step, i) => (
          <div key={i} className={`rounded-lg px-4 py-3 text-sm ${typeStyles[step.type] ?? "bg-surface border border-line"}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-semibold text-ink-soft">
                {step.role === "assistant" ? "Agent" : "System"}
              </span>
              {typeLabels[step.type] && (
                <span className="text-xs text-ink-faint">{typeLabels[step.type]}</span>
              )}
              {step.toolName && step.type === "tool_use" && (
                <span className="text-xs font-mono text-primary">{step.toolName}</span>
              )}
              {step.sidechain && (
                <span className="text-xs rounded bg-surface-muted px-1.5 py-0.5 text-ink-faint">
                  subagent
                </span>
              )}
            </div>
            <pre className="whitespace-pre-wrap font-sans text-sm max-h-64 overflow-y-auto">
              {step.content}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
