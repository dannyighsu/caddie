"use client";

import { useState, useEffect, useRef } from "react";
import { useParams } from "next/navigation";

interface Agent {
  id: string;
  name: string;
  capabilities: string[];
  /** Always resolved by the API — the agent's own value or the runtime default. */
  maxTurns: number;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  /** Set when the agent purged it as suspected phishing / prompt injection (content is empty). */
  purged?: { reason: string };
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
  category: "persona" | "skill" | "core-skill" | "config";
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
    return <p className="text-ink-faint">Loading...</p>;
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col">
      <div className="mb-4">
        <h1 className="text-xl font-semibold">{agent.name}</h1>
        <p className="text-xs text-ink-faint mt-1">
          {agent.capabilities.join(", ")}
          {" · "}Max {agent.maxTurns} turns
        </p>
        <div className="flex gap-4 mt-3 border-b border-line">
          <button
            onClick={() => setTab("main")}
            className={`pb-2 text-sm font-medium transition-colors ${
              tab === "main"
                ? "text-primary border-b-2 border-primary"
                : "text-ink-faint hover:text-ink"
            }`}
          >
            Conversations
          </button>
          <button
            onClick={() => setTab("config")}
            className={`pb-2 text-sm font-medium transition-colors ${
              tab === "config"
                ? "text-primary border-b-2 border-primary"
                : "text-ink-faint hover:text-ink"
            }`}
          >
            Config
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {tab === "main" ? (
          <ConversationsView agentId={agentId} />
        ) : (
          <ConfigView agentId={agentId} />
        )}
      </div>
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
          <h2 className="text-sm font-semibold text-ink-soft uppercase tracking-wide">
            History
          </h2>
          <button
            onClick={() => { setActiveConversation(null); setPrompt(""); }}
            className="text-xs px-2 py-1 bg-surface-muted text-ink-soft rounded hover:bg-primary-soft hover:text-primary transition-colors"
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
                  ? "bg-primary-soft text-primary"
                  : "text-ink-soft hover:bg-surface-muted hover:text-ink"
              }`}
            >
              <p className="truncate">{conv.title || "Untitled"}</p>
              <p className="text-xs text-ink-faint mt-0.5">
                {conv.messages.length} messages ·{" "}
                {new Date(conv.updated_at).toLocaleDateString()}
              </p>
            </button>
          ))}
          {conversations.length === 0 && (
            <p className="text-xs text-ink-faint px-3 py-2">No conversations yet</p>
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
                    ? "bg-primary text-white"
                    : "bg-surface border border-line text-ink shadow-sm"
                }`}
              >
                {msg.purged ? (
                  <p className="italic opacity-70">
                    [removed — suspected {msg.purged.reason === "other" ? "unsafe content" : msg.purged.reason}]
                  </p>
                ) : (
                  <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
                )}
                <p className="text-xs opacity-60 mt-2">
                  {new Date(msg.timestamp).toLocaleTimeString()}
                </p>
              </div>
            </div>
          ))}
          {running && (
            <div className="flex justify-start">
              <div className="bg-surface border border-line shadow-sm rounded-lg px-4 py-3 text-sm text-ink-soft">
                Thinking...
              </div>
            </div>
          )}
          {!activeConversation && !running && (
            <div className="flex-1 flex items-center justify-center text-ink-faint text-sm">
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
            className="flex-1 bg-surface-muted border border-line-strong rounded-lg p-3 text-sm resize-none h-20 focus:outline-none focus:border-primary focus:bg-surface"
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.metaKey) handleSend();
            }}
          />
          <button
            onClick={handleSend}
            disabled={running || !prompt.trim()}
            className="px-4 self-end bg-primary text-white rounded-lg text-sm font-medium h-10 hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
  const [newSkillName, setNewSkillName] = useState("");
  const [skillError, setSkillError] = useState<string | null>(null);

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
        body: JSON.stringify({ content: editContent, category: activeFile.category }),
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
      body: JSON.stringify({ content: "", category: "config" }),
    });
    setNewFileName("");
    refreshFiles();
  }

  /**
   * Create a new skill: a directory under the agent definition's
   * .claude/skills/ holding a SKILL.md scaffolded with the frontmatter Claude
   * Code needs to discover it. The agent picks it up on its next run — the
   * workspace mounts the skills directory by symlink, so nothing to rebuild.
   */
  async function handleCreateSkill() {
    const slug = newSkillName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug) return;
    if (skillFiles.some((f) => f.name.split("/")[1] === slug)) {
      setSkillError(`Skill "${slug}" already exists`);
      return;
    }

    const scaffold = `---\nname: ${slug}\ndescription: TODO — one line on what this skill does and when to use it.\n---\n\n## ${slug}\n\nTODO: the procedure.\n`;

    const res = await fetch(
      `/api/agents/${agentId}/config/skills/${slug}/SKILL.md`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: scaffold, category: "skill" }),
      }
    );
    if (!res.ok) {
      setSkillError("Could not create skill");
      return;
    }
    setNewSkillName("");
    setSkillError(null);
    setActiveFile({
      name: `skills/${slug}/SKILL.md`,
      content: scaffold,
      category: "skill",
    });
    setEditContent(scaffold);
    refreshFiles();
  }

  async function handleDelete(file: ConfigFile) {
    if (file.category === "skill") {
      const skill = file.name.split("/")[1];
      if (
        !confirm(
          `Delete the "${skill}" skill? This removes its whole directory and takes effect on the agent's next run.`
        )
      ) {
        return;
      }
    }
    await fetch(
      `/api/agents/${agentId}/config/${file.name}?category=${file.category}`,
      { method: "DELETE" }
    );
    if (activeFile?.name === file.name) {
      setActiveFile(null);
      setEditContent("");
    }
    refreshFiles();
  }

  const hasChanges = activeFile && editContent !== activeFile.content;

  const personaFiles = files.filter((f) => f.category === "persona");
  const skillFiles = files.filter((f) => f.category === "skill");
  const coreSkillFiles = files.filter((f) => f.category === "core-skill");
  const configFiles = files.filter((f) => f.category === "config");

  function FileEntry({ file, deletable }: { file: ConfigFile; deletable?: boolean }) {
    return (
      <div className="flex items-center group">
        <button
          onClick={() => selectFile(file)}
          className={`flex-1 text-left px-3 py-2 rounded-lg text-sm transition-colors ${
            activeFile?.name === file.name
              ? "bg-primary-soft text-primary"
              : "text-ink-soft hover:bg-surface-muted hover:text-ink"
          }`}
        >
          {file.category === "skill" || file.category === "core-skill"
            ? file.name.split("/")[1]
            : file.name}
        </button>
        {deletable && (
          <button
            onClick={() => handleDelete(file)}
            className="px-2 text-ink-faint hover:text-bad opacity-0 group-hover:opacity-100 transition-opacity text-xs"
          >
            x
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex gap-6 h-full">
      <div className="w-64 flex-shrink-0 flex flex-col">
        <div className="flex-1 overflow-y-auto space-y-4">
          {personaFiles.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-ink-faint uppercase tracking-wide mb-1 px-3">
                Persona
              </h2>
              {personaFiles.map((f) => <FileEntry key={f.name} file={f} />)}
            </div>
          )}

          <div>
            <h2 className="text-xs font-semibold text-ink-faint uppercase tracking-wide mb-1 px-3">
              Skills
            </h2>
            {skillFiles.map((f) => (
              <FileEntry key={f.name} file={f} deletable />
            ))}
            {skillFiles.length === 0 && (
              <p className="text-xs text-ink-faint px-3 py-2">No skills yet</p>
            )}
            <div className="mt-1 px-3 flex gap-1">
              <input
                value={newSkillName}
                onChange={(e) => {
                  setNewSkillName(e.target.value);
                  setSkillError(null);
                }}
                placeholder="new-skill-name"
                className="flex-1 min-w-0 bg-surface-muted border border-line-strong rounded px-2 py-1 text-xs focus:outline-none focus:border-primary focus:bg-surface"
                onKeyDown={(e) => { if (e.key === "Enter") handleCreateSkill(); }}
              />
              <button
                onClick={handleCreateSkill}
                disabled={!newSkillName.trim()}
                className="px-2 py-1 bg-surface-muted text-ink-soft rounded text-xs hover:bg-primary-soft hover:text-primary disabled:opacity-40 transition-colors"
              >
                +
              </button>
            </div>
            {skillError && (
              <p className="text-xs text-bad px-3 pt-1">{skillError}</p>
            )}
          </div>

          {coreSkillFiles.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-ink-faint uppercase tracking-wide mb-1 px-3">
                Shared skills
              </h2>
              <p className="text-xs text-ink-faint px-3 pb-1 leading-snug">
                Used by every agent. Editing one changes it everywhere.
              </p>
              {coreSkillFiles.map((f) => (
                <FileEntry key={f.name} file={f} />
              ))}
            </div>
          )}

          <div>
            <h2 className="text-xs font-semibold text-ink-faint uppercase tracking-wide mb-1 px-3">
              Config
            </h2>
            {configFiles.map((f) => <FileEntry key={f.name} file={f} deletable />)}
            {configFiles.length === 0 && (
              <p className="text-xs text-ink-faint px-3 py-2">No config files yet</p>
            )}
          </div>
        </div>
        <div className="mt-3 flex gap-1">
          <input
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            placeholder="new_config_file.md"
            className="flex-1 bg-surface-muted border border-line-strong rounded px-2 py-1 text-xs focus:outline-none focus:border-primary focus:bg-surface"
            onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
          />
          <button
            onClick={handleCreate}
            disabled={!newFileName.trim()}
            className="px-2 py-1 bg-surface-muted text-ink-soft rounded text-xs hover:bg-primary-soft hover:text-primary disabled:opacity-40 transition-colors"
          >
            +
          </button>
        </div>
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {activeFile ? (
          <>
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-ink">{activeFile.name}</span>
              <button
                onClick={handleSave}
                disabled={saving || !hasChanges}
                className="px-3 py-1 bg-primary text-white rounded text-xs font-medium hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? "Saving..." : hasChanges ? "Save" : "Saved"}
              </button>
            </div>
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="flex-1 bg-surface-muted border border-line-strong rounded-lg p-3 text-sm font-mono resize-none focus:outline-none focus:border-primary focus:bg-surface"
              onKeyDown={(e) => {
                if (e.key === "s" && e.metaKey) { e.preventDefault(); handleSave(); }
              }}
            />
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-ink-faint text-sm">
            Select a file to edit.
          </div>
        )}
      </div>
    </div>
  );
}
