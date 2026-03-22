"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

interface ConnectionStatus {
  provider: string;
  connected: boolean;
  metadata?: Record<string, unknown>;
  connectedAt?: string;
}

interface SlackChannelIdentity {
  appId: string;
  channelId: string;
  teamId: string;
}

const providerInfo: Record<
  string,
  { name: string; description: string; icon: string }
> = {
  google: {
    name: "Google Calendar",
    description: "Access your calendar events and schedule",
    icon: "📅",
  },
  notion: {
    name: "Notion",
    description: "Access your Notion workspace and pages",
    icon: "📝",
  },
};

interface MCPDebugResult {
  success: boolean;
  clientType?: string;
  connection?: { url: string; workspace: string; type?: string; host?: string };
  tools?: string[];
  toolCount?: number;
  files?: unknown;
  error?: string;
}

function SettingsContent() {
  const searchParams = useSearchParams();
  const [connections, setConnections] = useState<Record<string, ConnectionStatus>>({});
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState<string | null>(null);
  const [agentId, setAgentId] = useState("");
  const [webhookStatus, setWebhookStatus] = useState<"idle" | "registering" | "success" | "error">("idle");
  const [webhookError, setWebhookError] = useState("");

  // MCP Debug state
  const [mcpDebugStatus, setMcpDebugStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [mcpDebugResult, setMcpDebugResult] = useState<MCPDebugResult | null>(null);

  // Notion MCP Debug state
  const [notionMcpStatus, setNotionMcpStatus] = useState<"idle" | "testing" | "success" | "error">("idle");
  const [notionMcpResult, setNotionMcpResult] = useState<MCPDebugResult | null>(null);

  // Default Slack channel state
  const [slackChannel, setSlackChannel] = useState<SlackChannelIdentity | null>(null);
  const [slackChannelForm, setSlackChannelForm] = useState({ appId: "", channelId: "", teamId: "" });
  const [slackChannelStatus, setSlackChannelStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [slackChannelError, setSlackChannelError] = useState("");

  const success = searchParams.get("success");
  const error = searchParams.get("error");

  useEffect(() => {
    fetchConnections();
    fetchSlackChannel();
  }, []);

  async function fetchConnections() {
    try {
      const res = await fetch("/api/auth/status");
      if (res.ok) {
        setConnections(await res.json());
      }
    } catch (error) {
      console.error("Failed to fetch connections:", error);
    } finally {
      setLoading(false);
    }
  }

  async function fetchSlackChannel() {
    try {
      const res = await fetch("/api/settings/slack-channel");
      if (res.ok) {
        const data = await res.json();
        if (data.channel) {
          setSlackChannel(data.channel);
          setSlackChannelForm(data.channel);
        }
      }
    } catch (error) {
      console.error("Failed to fetch Slack channel:", error);
    }
  }

  async function disconnect(provider: string) {
    setDisconnecting(provider);
    try {
      const res = await fetch("/api/auth/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (res.ok) {
        await fetchConnections();
      }
    } catch (error) {
      console.error("Failed to disconnect:", error);
    } finally {
      setDisconnecting(null);
    }
  }

  async function registerWebhook() {
    if (!agentId.trim()) {
      setWebhookError("Agent ID is required");
      setWebhookStatus("error");
      return;
    }

    setWebhookStatus("registering");
    setWebhookError("");

    try {
      const res = await fetch("/api/chatkit/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agentId.trim() }),
      });

      const data = await res.json();

      if (res.ok) {
        setWebhookStatus("success");
      } else {
        setWebhookError(data.error || "Failed to register webhook");
        setWebhookStatus("error");
      }
    } catch (err) {
      console.error("Failed to register webhook:", err);
      setWebhookError("Network error");
      setWebhookStatus("error");
    }
  }

  async function saveSlackChannel() {
    const { appId, channelId, teamId } = slackChannelForm;
    if (!appId.trim() || !channelId.trim() || !teamId.trim()) {
      setSlackChannelError("All fields are required");
      setSlackChannelStatus("error");
      return;
    }

    setSlackChannelStatus("saving");
    setSlackChannelError("");

    try {
      const res = await fetch("/api/settings/slack-channel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appId: appId.trim(),
          channelId: channelId.trim(),
          teamId: teamId.trim(),
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setSlackChannelStatus("success");
        setSlackChannel({ appId: appId.trim(), channelId: channelId.trim(), teamId: teamId.trim() });
      } else {
        setSlackChannelError(data.error || "Failed to save Slack channel");
        setSlackChannelStatus("error");
      }
    } catch (err) {
      console.error("Failed to save Slack channel:", err);
      setSlackChannelError("Network error");
      setSlackChannelStatus("error");
    }
  }

  async function clearSlackChannel() {
    try {
      const res = await fetch("/api/settings/slack-channel", { method: "DELETE" });
      if (res.ok) {
        setSlackChannel(null);
        setSlackChannelForm({ appId: "", channelId: "", teamId: "" });
        setSlackChannelStatus("idle");
      }
    } catch (err) {
      console.error("Failed to clear Slack channel:", err);
    }
  }

  async function testMCPConnection(useNative: boolean = false) {
    setMcpDebugStatus("testing");
    setMcpDebugResult(null);

    try {
      const url = useNative ? "/api/debug/mcp?native=true" : "/api/debug/mcp";
      const res = await fetch(url);
      const data = await res.json();

      if (res.ok && data.success) {
        setMcpDebugStatus("success");
        setMcpDebugResult(data);
      } else {
        setMcpDebugStatus("error");
        setMcpDebugResult(data);
      }
    } catch (err) {
      console.error("Failed to test MCP connection:", err);
      setMcpDebugStatus("error");
      setMcpDebugResult({
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  async function testNotionMCPConnection() {
    setNotionMcpStatus("testing");
    setNotionMcpResult(null);

    try {
      const res = await fetch("/api/debug/notion-mcp");
      const data = await res.json();

      if (res.ok && data.success) {
        setNotionMcpStatus("success");
        setNotionMcpResult(data);
      } else {
        setNotionMcpStatus("error");
        setNotionMcpResult(data);
      }
    } catch (err) {
      console.error("Failed to test Notion MCP connection:", err);
      setNotionMcpStatus("error");
      setNotionMcpResult({
        success: false,
        error: err instanceof Error ? err.message : "Network error",
      });
    }
  }

  return (
    <>
      {/* Status Messages */}
      {success && (
        <div className="mb-6 p-4 rounded-lg bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 border border-green-200 dark:border-green-800">
          Successfully connected to {success}!
        </div>
      )}
      {error && (
        <div className="mb-6 p-4 rounded-lg bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800">
          Failed to connect: {error.replace(/_/g, " ")}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-neutral-500">Loading...</div>
      ) : (
        <div className="space-y-8">
          {/* Connected Services */}
          <section>
            <h2 className="text-lg font-medium mb-4">Connected Services</h2>
            <p className="text-sm text-neutral-500 mb-6">
              Connect your services to enable the AI assistant to access your
              calendar, tasks, and messages.
            </p>

            <div className="space-y-4">
              {Object.entries(providerInfo).map(([provider, info]) => {
                const conn = connections[provider];
                const isConnected = conn?.connected;

                return (
                  <div
                    key={provider}
                    className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-4">
                        <div className="text-2xl">{info.icon}</div>
                        <div>
                          <h3 className="font-medium">{info.name}</h3>
                          <p className="text-sm text-neutral-500 mt-1">
                            {info.description}
                          </p>
                          {isConnected && conn.metadata && (
                            <div className="mt-3 text-sm">
                              <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                                Connected
                              </span>
                              <div className="mt-2 text-neutral-500">
                                {provider === "google" && conn.metadata.email ? (
                                  <span>{`${conn.metadata.email}`}</span>
                                ) : null}
                                {provider === "notion" && conn.metadata.workspace_name ? (
                                  <span>{`${conn.metadata.workspace_name}`}</span>
                                ) : null}
                                {provider === "notion" && conn.metadata.mode === "internal" ? (
                                  <span>Internal Integration</span>
                                ) : null}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                      <div>
                        {isConnected ? (
                          <button
                            onClick={() => disconnect(provider)}
                            disabled={disconnecting === provider}
                            className="px-4 py-2 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {disconnecting === provider
                              ? "Disconnecting..."
                              : "Disconnect"}
                          </button>
                        ) : (
                          <a
                            href={`/api/auth/${provider}`}
                            className="inline-flex px-4 py-2 text-sm bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity"
                          >
                            Connect
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Slack Integration */}
          <section>
            <h2 className="text-lg font-medium mb-4">Slack Integration</h2>
            <div className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800">
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="text-2xl">💬</div>
                  <div>
                    <h3 className="font-medium">Slack</h3>
                    <p className="text-sm text-neutral-500 mt-1">
                      Connect to Slack to send and receive messages.
                    </p>
                  </div>
                </div>
                <a
                  href="https://slack.com/oauth/v2/authorize?client_id=8446271669456.10165812080567&scope=app_mentions:read,channels:history,channels:join,channels:read,chat:write,chat:write.customize,chat:write.public,files:read,groups:history,im:history,im:write,incoming-webhook,links:read,links:write,users.profile:read,groups:read&user_scope="
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <img
                    alt="Add to Slack"
                    height="40"
                    width="139"
                    src="https://platform.slack-edge.com/img/add_to_slack.png"
                    srcSet="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x"
                  />
                </a>
              </div>
            </div>
          </section>

          {/* ChatKit Webhook Registration */}
          <section>
            <h2 className="text-lg font-medium mb-4">ChatKit Webhook</h2>
            <div className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800">
              <p className="text-sm text-neutral-500 mb-4">
                Register a webhook with ChatKit to receive incoming messages. Enter your ChatKit Agent ID below.
              </p>
              <div className="flex gap-3">
                <input
                  type="text"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                  placeholder="Enter ChatKit Agent ID"
                  className="flex-1 px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={registerWebhook}
                  disabled={webhookStatus === "registering"}
                  className="px-4 py-2 text-sm bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {webhookStatus === "registering" ? "Registering..." : "Register Webhook"}
                </button>
              </div>
              {webhookStatus === "success" && (
                <div className="mt-3 text-sm text-green-600 dark:text-green-400">
                  Webhook registered successfully!
                </div>
              )}
              {webhookStatus === "error" && webhookError && (
                <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {webhookError}
                </div>
              )}
            </div>
          </section>

          {/* Default Slack Channel */}
          <section>
            <h2 className="text-lg font-medium mb-4">Default Slack Channel</h2>
            <div className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800">
              <p className="text-sm text-neutral-500 mb-4">
                Configure the default Slack channel for scheduled check-ins. This is where the AI will send proactive messages.
              </p>
              {slackChannel && (
                <div className="mb-4 p-3 rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800">
                  <div className="flex items-center justify-between">
                    <div className="text-sm">
                      <span className="text-green-700 dark:text-green-300 font-medium">Configured</span>
                      <span className="text-neutral-500 ml-2">
                        Channel: {slackChannel.channelId}
                      </span>
                    </div>
                    <button
                      onClick={clearSlackChannel}
                      className="text-sm text-red-600 hover:text-red-700"
                    >
                      Clear
                    </button>
                  </div>
                </div>
              )}
              <div className="space-y-3">
                <div>
                  <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-1">
                    Team ID
                  </label>
                  <input
                    type="text"
                    value={slackChannelForm.teamId}
                    onChange={(e) => setSlackChannelForm({ ...slackChannelForm, teamId: e.target.value })}
                    placeholder="T08D47ZKPDE"
                    className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-1">
                    Channel ID
                  </label>
                  <input
                    type="text"
                    value={slackChannelForm.channelId}
                    onChange={(e) => setSlackChannelForm({ ...slackChannelForm, channelId: e.target.value })}
                    placeholder="C08CFDGC750"
                    className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm text-neutral-600 dark:text-neutral-400 mb-1">
                    App ID
                  </label>
                  <input
                    type="text"
                    value={slackChannelForm.appId}
                    onChange={(e) => setSlackChannelForm({ ...slackChannelForm, appId: e.target.value })}
                    placeholder="A08CFB2KLAX"
                    className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <button
                  onClick={saveSlackChannel}
                  disabled={slackChannelStatus === "saving"}
                  className="px-4 py-2 text-sm bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {slackChannelStatus === "saving" ? "Saving..." : "Save Channel"}
                </button>
              </div>
              {slackChannelStatus === "success" && (
                <div className="mt-3 text-sm text-green-600 dark:text-green-400">
                  Default Slack channel saved successfully!
                </div>
              )}
              {slackChannelStatus === "error" && slackChannelError && (
                <div className="mt-3 text-sm text-red-600 dark:text-red-400">
                  {slackChannelError}
                </div>
              )}
            </div>
          </section>

          {/* Debug: MCP Connection */}
          <section>
            <h2 className="text-lg font-medium mb-4">Debug: MCP Filesystem</h2>
            <div className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800">
              <p className="text-sm text-neutral-500 mb-4">
                Test the connection to the ConstellationFS MCP backend and list available tools.
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => testMCPConnection(false)}
                  disabled={mcpDebugStatus === "testing"}
                  className="px-4 py-2 text-sm bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {mcpDebugStatus === "testing" ? "Testing..." : "Test AI SDK Client"}
                </button>
                <button
                  onClick={() => testMCPConnection(true)}
                  disabled={mcpDebugStatus === "testing"}
                  className="px-4 py-2 text-sm border border-foreground text-foreground rounded-lg hover:bg-foreground/10 transition-colors disabled:opacity-50"
                >
                  {mcpDebugStatus === "testing" ? "Testing..." : "Test Native Client"}
                </button>
              </div>
              {mcpDebugResult && (
                <div className={`mt-4 p-4 rounded-lg text-sm ${
                  mcpDebugResult.success
                    ? "bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                }`}>
                  {mcpDebugResult.success ? (
                    <div className="space-y-2">
                      <div className="text-green-700 dark:text-green-300 font-medium">Connection successful!</div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>Client:</strong> {mcpDebugResult.clientType}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>URL:</strong> {mcpDebugResult.connection?.url}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>Workspace:</strong> {mcpDebugResult.connection?.workspace}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>Tools:</strong> {mcpDebugResult.tools?.join(", ") || "None"}
                      </div>
                      {mcpDebugResult.files != null && (
                        <div className="text-neutral-600 dark:text-neutral-400">
                          <strong>Files:</strong>
                          <pre className="mt-1 p-2 bg-neutral-100 dark:bg-neutral-800 rounded text-xs overflow-auto max-h-40">
                            {JSON.stringify(mcpDebugResult.files as object, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-red-700 dark:text-red-300">
                      <strong>Error:</strong> {mcpDebugResult.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* Debug: Notion MCP Tools */}
          <section>
            <h2 className="text-lg font-medium mb-4">Debug: Notion MCP Tools</h2>
            <div className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800">
              <p className="text-sm text-neutral-500 mb-4">
                Test the Notion MCP server connection via ConstellationFS workspace.exec().
                This spawns the Notion MCP server on the remote VM and connects via STDIO over SSH.
              </p>
              <button
                onClick={testNotionMCPConnection}
                disabled={notionMcpStatus === "testing"}
                className="px-4 py-2 text-sm bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {notionMcpStatus === "testing" ? "Testing..." : "Test Notion MCP Server"}
              </button>
              {notionMcpResult && (
                <div className={`mt-4 p-4 rounded-lg text-sm ${
                  notionMcpResult.success
                    ? "bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800"
                    : "bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"
                }`}>
                  {notionMcpResult.success ? (
                    <div className="space-y-2">
                      <div className="text-green-700 dark:text-green-300 font-medium">Connection successful!</div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>Client:</strong> {notionMcpResult.clientType}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>Connection:</strong> {notionMcpResult.connection?.type}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>Workspace:</strong> {notionMcpResult.connection?.workspace}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>Host:</strong> {notionMcpResult.connection?.host}
                      </div>
                      <div className="text-neutral-600 dark:text-neutral-400">
                        <strong>Tool Count:</strong> {notionMcpResult.toolCount || notionMcpResult.tools?.length || 0}
                      </div>
                      {notionMcpResult.tools && notionMcpResult.tools.length > 0 && (
                        <div className="text-neutral-600 dark:text-neutral-400">
                          <strong>Available Tools:</strong>
                          <div className="mt-1 p-2 bg-neutral-100 dark:bg-neutral-800 rounded text-xs">
                            {notionMcpResult.tools.join(", ")}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="text-red-700 dark:text-red-300">
                      <strong>Error:</strong> {notionMcpResult.error}
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>

          {/* About */}
          <section>
            <h2 className="text-lg font-medium mb-4">About Northstar</h2>
            <div className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800">
              <p className="text-sm text-neutral-600 dark:text-neutral-400">
                Northstar is an AI-powered personal assistant that helps you manage
                your tasks and communications. It connects to your Google Calendar,
                Notion, and Slack to provide personalized check-ins and help you
                stay on top of your work.
              </p>
              <p className="text-sm text-neutral-500 mt-4">
                Version 0.1.0
              </p>
            </div>
          </section>
        </div>
      )}
    </>
  );
}

export default function Settings() {
  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      <Suspense fallback={<div className="text-center py-12 text-neutral-500">Loading...</div>}>
        <SettingsContent />
      </Suspense>
    </main>
  );
}
