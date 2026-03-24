"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";

interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  maxTurns?: number;
  enableChrome?: boolean;
  mode?: "conversational" | "triggered";
  triggerRoute?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface Conversation {
  id: string;
  agent_id: string;
  session_id: string | null;
  title: string | null;
  messages: Message[];
  created_at: string;
  updated_at: string;
}

interface ConfigFile {
  name: string;
  content: string;
}

type Tab = "main" | "config";

export default function AgentPage() {
  const params = useParams<{ id: string }>();
  const agentId = params.id;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [tab, setTab] = useState<Tab>("main");

  useEffect(() => {
    fetch(`/api/agents/${agentId}`)
      .then((r) => r.json())
      .then(setAgent);
  }, [agentId]);

  if (!agent) {
    return <p className="text-gray-500">Loading...</p>;
  }

  const isTriggered = agent.mode === "triggered";

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">{agent.name}</h1>
        <p className="text-xs text-gray-500 mt-1">
          {agent.capabilities.join(", ")}
          {" · "}Max {agent.maxTurns ?? 20} turns
          {isTriggered && " · Triggered"}
        </p>
        <div className="flex gap-4 mt-3 border-b border-gray-800">
          <button
            onClick={() => setTab("main")}
            className={`pb-2 text-sm font-medium transition-colors ${
              tab === "main"
                ? "text-white border-b-2 border-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            {isTriggered ? "Runs" : "Conversations"}
          </button>
          <button
            onClick={() => setTab("config")}
            className={`pb-2 text-sm font-medium transition-colors ${
              tab === "config"
                ? "text-white border-b-2 border-white"
                : "text-gray-500 hover:text-gray-300"
            }`}
          >
            Config
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {tab === "main" ? (
          isTriggered ? (
            <TriggeredView agent={agent} />
          ) : (
            <ConversationsView agentId={agentId} />
          )
        ) : (
          <ConfigView agentId={agentId} />
        )}
      </div>
    </div>
  );
}

// =============================================================================
// Triggered View (for xmanager etc.)
// =============================================================================

function TriggeredView({ agent }: { agent: Agent }) {
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(null);
  const [history, setHistory] = useState<Array<{ timestamp: string; result: Record<string, unknown> }>>([]);

  async function handleTrigger() {
    if (running || !agent.triggerRoute) return;
    setRunning(true);
    setLastResult(null);

    try {
      const res = await fetch(agent.triggerRoute, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      setLastResult(data);
      setHistory((prev) => [
        { timestamp: new Date().toISOString(), result: data },
        ...prev,
      ]);
    } catch (err) {
      setLastResult({
        success: false,
        error: err instanceof Error ? err.message : "Request failed",
      });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <button
          onClick={handleTrigger}
          disabled={running || !agent.triggerRoute}
          className="px-6 py-3 bg-white text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          {running ? "Running..." : "Run"}
        </button>
        {!agent.triggerRoute && (
          <p className="text-xs text-gray-500 mt-2">
            No trigger route configured for this agent.
          </p>
        )}
      </div>

      {lastResult && (
        <div
          className={`border rounded-lg p-4 ${
            lastResult.success
              ? "border-green-800 bg-green-950/30"
              : "border-red-800 bg-red-950/30"
          }`}
        >
          <span
            className={`text-xs font-medium ${
              lastResult.success ? "text-green-400" : "text-red-400"
            }`}
          >
            {lastResult.success ? "Completed" : "Failed"}
          </span>
          <pre className="text-sm whitespace-pre-wrap text-gray-200 mt-2 max-h-96 overflow-y-auto">
            {JSON.stringify(lastResult, null, 2)}
          </pre>
        </div>
      )}

      {history.length > 1 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">Previous Runs</h2>
          <div className="space-y-2">
            {history.slice(1).map((entry, i) => (
              <details key={i} className="border border-gray-800 rounded-lg">
                <summary className="p-3 text-sm cursor-pointer hover:bg-gray-900/50 flex justify-between">
                  <span className={entry.result.success ? "text-green-400" : "text-red-400"}>
                    {entry.result.success ? "Success" : "Failed"}
                  </span>
                  <span className="text-gray-500">
                    {new Date(entry.timestamp).toLocaleTimeString()}
                  </span>
                </summary>
                <pre className="p-3 border-t border-gray-800 text-xs whitespace-pre-wrap text-gray-300 max-h-48 overflow-y-auto">
                  {JSON.stringify(entry.result, null, 2)}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// Conversations View
// =============================================================================

function ConversationsView({ agentId }: { agentId: string }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    refreshConversations();
  }, [agentId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages]);

  function refreshConversations() {
    fetch(`/api/conversations?agentId=${agentId}`)
      .then((r) => r.json())
      .then(setConversations);
  }

  async function loadConversation(id: string) {
    const res = await fetch(`/api/conversations/${id}`);
    setActiveConversation(await res.json());
  }

  async function handleSend() {
    if (!prompt.trim() || running) return;
    setRunning(true);

    const userMessage: Message = {
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
    };

    if (activeConversation) {
      setActiveConversation({
        ...activeConversation,
        messages: [...activeConversation.messages, userMessage],
      });
    }

    const sentPrompt = prompt;
    setPrompt("");

    try {
      const res = await fetch(`/api/agents/${agentId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: sentPrompt,
          conversationId: activeConversation?.id,
        }),
      });
      const data = await res.json();

      if (data.conversationId) {
        await loadConversation(data.conversationId);
      }
      refreshConversations();
    } catch (err) {
      const errorMsg: Message = {
        role: "assistant",
        content: `Error: ${err instanceof Error ? err.message : "Request failed"}`,
        timestamp: new Date().toISOString(),
      };
      if (activeConversation) {
        setActiveConversation({
          ...activeConversation,
          messages: [...activeConversation.messages, userMessage, errorMsg],
        });
      }
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="flex gap-6 h-full">
      <div className="w-64 flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
            History
          </h2>
          <button
            onClick={() => { setActiveConversation(null); setPrompt(""); }}
            className="text-xs px-2 py-1 bg-gray-800 rounded hover:bg-gray-700 transition-colors"
          >
            + New
          </button>
        </div>
        <div className="flex-1 overflow-y-auto space-y-1">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              onClick={() => loadConversation(conv.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                activeConversation?.id === conv.id
                  ? "bg-gray-800 text-white"
                  : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
              }`}
            >
              <p className="truncate">{conv.title || "Untitled"}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {conv.messages.length} messages ·{" "}
                {new Date(conv.updated_at).toLocaleDateString()}
              </p>
            </button>
          ))}
          {conversations.length === 0 && (
            <p className="text-xs text-gray-600 px-3 py-2">No conversations yet</p>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto space-y-4 mb-4">
          {activeConversation?.messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
                  msg.role === "user"
                    ? "bg-blue-900/40 text-blue-100"
                    : "bg-gray-800 text-gray-200"
                }`}
              >
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
                <p className="text-xs text-gray-500 mt-2">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </p>
              </div>
            </div>
          ))}
          {running && (
            <div className="flex justify-start">
              <div className="bg-gray-800 rounded-lg px-4 py-3 text-sm text-gray-400">
                Thinking...
              </div>
            </div>
          )}
          {!activeConversation && !running && (
            <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
              Start a new conversation or select one from the sidebar.
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="flex gap-2">
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              activeConversation
                ? "Continue the conversation..."
                : "Start a new conversation..."
            }
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm resize-none h-20 focus:outline-none focus:border-gray-500"
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) handleSend();
            }}
          />
          <button
            onClick={handleSend}
            disabled={running || !prompt.trim()}
            className="px-4 self-end bg-white text-gray-900 rounded-lg text-sm font-medium h-10 hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {running ? "..." : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// Config View
// =============================================================================

function ConfigView({ agentId }: { agentId: string }) {
  const [files, setFiles] = useState<ConfigFile[]>([]);
  const [activeFile, setActiveFile] = useState<ConfigFile | null>(null);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [newFileName, setNewFileName] = useState("");

  useEffect(() => {
    refreshFiles();
  }, [agentId]);

  function refreshFiles() {
    fetch(`/api/agents/${agentId}/config`)
      .then((r) => r.json())
      .then((data: ConfigFile[]) => {
        setFiles(data);
        if (activeFile) {
          const updated = data.find((f: ConfigFile) => f.name === activeFile.name);
          if (updated) {
            setActiveFile(updated);
            setEditContent(updated.content);
          }
        }
      });
  }

  function selectFile(file: ConfigFile) {
    setActiveFile(file);
    setEditContent(file.content);
  }

  async function handleSave() {
    if (!activeFile) return;
    setSaving(true);
    try {
      await fetch(`/api/agents/${agentId}/config/${activeFile.name}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: editContent }),
      });
      refreshFiles();
    } finally {
      setSaving(false);
    }
  }

  async function handleCreate() {
    const name = newFileName.trim();
    if (!name) return;
    await fetch(`/api/agents/${agentId}/config/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "" }),
    });
    setNewFileName("");
    refreshFiles();
  }

  async function handleDelete(name: string) {
    await fetch(`/api/agents/${agentId}/config/${name}`, { method: "DELETE" });
    if (activeFile?.name === name) {
      setActiveFile(null);
      setEditContent("");
    }
    refreshFiles();
  }

  const hasChanges = activeFile && editContent !== activeFile.content;

  return (
    <div className="flex gap-6 h-full">
      <div className="w-64 flex-shrink-0 flex flex-col">
        <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">
          Config Files
        </h2>
        <div className="flex-1 overflow-y-auto space-y-1">
          {files.map((file) => (
            <div key={file.name} className="flex items-center group">
              <button
                onClick={() => selectFile(file)}
                className={`flex-1 text-left px-3 py-2 rounded-lg text-sm transition-colors ${
                  activeFile?.name === file.name
                    ? "bg-gray-800 text-white"
                    : "text-gray-400 hover:bg-gray-900 hover:text-gray-200"
                }`}
              >
                {file.name}
              </button>
              <button
                onClick={() => handleDelete(file.name)}
                className="px-2 text-gray-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity text-xs"
              >
                x
              </button>
            </div>
          ))}
          {files.length === 0 && (
            <p className="text-xs text-gray-600 px-3 py-2">No config files yet</p>
          )}
        </div>
        <div className="mt-3 flex gap-1">
          <input
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            placeholder="new_file.md"
            className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-gray-500"
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
          <button
            onClick={handleCreate}
            disabled={!newFileName.trim()}
            className="px-2 py-1 bg-gray-800 rounded text-xs hover:bg-gray-700 disabled:opacity-40 transition-colors"
          >
            +
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {activeFile ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-gray-300">{activeFile.name}</span>
              <button
                onClick={handleSave}
                disabled={saving || !hasChanges}
                className="px-3 py-1 bg-white text-gray-900 rounded text-xs font-medium hover:bg-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving..." : hasChanges ? "Save" : "Saved"}
              </button>
            </div>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg p-3 text-sm font-mono resize-none focus:outline-none focus:border-gray-500"
              onKeyDown={(e) => {
                if (e.key === "s" && e.metaKey) { e.preventDefault(); handleSave(); }
              }}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-600 text-sm">
            Select a config file to edit, or create a new one.
          </div>
        )}
      </div>
    </div>
  );
}
