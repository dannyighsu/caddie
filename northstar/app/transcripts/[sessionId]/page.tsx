"use client";

import { useState, useEffect } from "react";
import { useParams, useSearchParams } from "next/navigation";

interface TranscriptStep {
  role: "assistant" | "user" | "system";
  type: "text" | "tool_use" | "tool_result" | "thinking" | "progress";
  content: string;
  toolName?: string;
}

export default function TranscriptPage() {
  const params = useParams<{ sessionId: string }>();
  const searchParams = useSearchParams();
  const agentId = searchParams.get("agentId") ?? "buri";

  const [steps, setSteps] = useState<TranscriptStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/transcripts/${params.sessionId}?agentId=${agentId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error);
        else setSteps(data.steps ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [params.sessionId, agentId]);

  if (loading) return <p className="text-gray-500">Loading transcript...</p>;
  if (error) return <p className="text-red-400">Error: {error}</p>;

  const typeStyles: Record<string, string> = {
    text: "bg-gray-800 text-gray-200",
    tool_use: "bg-blue-950/40 text-blue-200 border-l-2 border-blue-700",
    tool_result: "bg-gray-900 text-gray-400 border-l-2 border-gray-700",
    thinking: "bg-purple-950/30 text-purple-300 border-l-2 border-purple-700",
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
          <h1 className="text-xl font-semibold">Transcript</h1>
          <p className="text-xs text-gray-500 mt-1">
            Session: {params.sessionId.substring(0, 12)}... | Agent: {agentId}
          </p>
        </div>
        <span className="text-xs text-gray-500">{steps.length} steps</span>
      </div>

      <div className="space-y-2">
        {steps.map((step, i) => (
          <div key={i} className={`rounded-lg px-4 py-3 text-sm ${typeStyles[step.type] ?? "bg-gray-800"}`}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium text-gray-500">
                {step.role === "assistant" ? "Agent" : "System"}
              </span>
              {typeLabels[step.type] && (
                <span className="text-xs text-gray-600">{typeLabels[step.type]}</span>
              )}
              {step.toolName && step.type === "tool_use" && (
                <span className="text-xs font-mono text-blue-400">{step.toolName}</span>
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
