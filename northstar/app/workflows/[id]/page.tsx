"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";

interface Workflow {
  id: string;
  name: string;
  capabilities: string[];
  maxTurns?: number;
  enableChrome?: boolean;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
}

interface Conversation {
  id: string;
  workflow_id: string;
  session_id: string | null;
  title: string | null;
  messages: Message[];
  created_at: string;
  updated_at: string;
}

export default function WorkflowPage() {
  const params = useParams<{ id: string }>();
  const workflowId = params.id;

  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [prompt, setPrompt] = useState("");
  const [running, setRunning] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Load workflow and conversations
  useEffect(() => {
    fetch(`/api/workflows/${workflowId}`)
      .then((r) => r.json())
      .then(setWorkflow);
    refreshConversations();
  }, [workflowId]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeConversation?.messages]);

  function refreshConversations() {
    fetch(`/api/conversations?workflowId=${workflowId}`)
      .then((r) => r.json())
      .then(setConversations);
  }

  async function loadConversation(id: string) {
    const res = await fetch(`/api/conversations/${id}`);
    const conv: Conversation = await res.json();
    setActiveConversation(conv);
  }

  function startNewConversation() {
    setActiveConversation(null);
    setPrompt("");
  }

  async function handleSend() {
    if (!prompt.trim() || running) return;
    setRunning(true);

    // Optimistically add user message to UI
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
      const res = await fetch(`/api/workflows/${workflowId}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: sentPrompt,
          conversationId: activeConversation?.id,
        }),
      });
      const data = await res.json();

      if (data.conversationId) {
        // Reload full conversation from DB
        await loadConversation(data.conversationId);
      }
      refreshConversations();
    } catch (err) {
      // Add error message to conversation
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

  if (!workflow) {
    return <p className="text-gray-500">Loading...</p>;
  }

  return (
    <div className="flex gap-6 h-[calc(100vh-8rem)]">
      {/* Sidebar: conversation list */}
      <div className="w-64 flex-shrink-0 flex flex-col">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide">
            Conversations
          </h2>
          <button
            onClick={startNewConversation}
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
            <p className="text-xs text-gray-600 px-3 py-2">
              No conversations yet
            </p>
          )}
        </div>
      </div>

      {/* Main: conversation view */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="mb-4">
          <h1 className="text-xl font-semibold">{workflow.name}</h1>
          <p className="text-xs text-gray-500 mt-1">
            {workflow.capabilities.join(", ")}
            {" · "}Max {workflow.maxTurns ?? 20} turns
            {activeConversation?.session_id && (
              <>
                {" · "}Session:{" "}
                {activeConversation.session_id.substring(0, 8)}...
              </>
            )}
          </p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto space-y-4 mb-4">
          {activeConversation?.messages.map((msg, i) => (
            <div
              key={i}
              className={`flex ${
                msg.role === "user" ? "justify-end" : "justify-start"
              }`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-4 py-3 text-sm ${
                  msg.role === "user"
                    ? "bg-blue-900/40 text-blue-100"
                    : "bg-gray-800 text-gray-200"
                }`}
              >
                <pre className="whitespace-pre-wrap font-sans">
                  {msg.content}
                </pre>
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

        {/* Input */}
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
