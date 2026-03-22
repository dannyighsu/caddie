"use client";

import { useEffect, useState } from "react";

interface XManagerStatus {
  userId: string;
  isRunning: boolean;
  lastRun: {
    time: string;
    summary: string;
  } | null;
  nextScheduledRun: {
    time: string;
    status: string;
  } | null;
}

export default function XManagerPage() {
  const [xManagerStatus, setXManagerStatus] = useState<XManagerStatus | null>(null);
  const [xManagerRunning, setXManagerRunning] = useState(false);
  const [loading, setLoading] = useState(true);

  // Config state
  const [xUsername, setXUsername] = useState("");
  const [modelId, setModelId] = useState<string>("google/gemini-3-flash-preview");
  const [xUsernameStatus, setXUsernameStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [xUsernameError, setXUsernameError] = useState("");
  const [areasOfInterest, setAreasOfInterest] = useState("");
  const [areasOfInterestStatus, setAreasOfInterestStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [areasOfInterestError, setAreasOfInterestError] = useState("");
  const [engagementCriteria, setEngagementCriteria] = useState("");
  const [engagementCriteriaStatus, setEngagementCriteriaStatus] = useState<"idle" | "saving" | "success" | "error">("idle");
  const [engagementCriteriaError, setEngagementCriteriaError] = useState("");
  const [loginStatus, setLoginStatus] = useState<"idle" | "running" | "success" | "error">("idle");
  const [loginError, setLoginError] = useState("");

  async function fetchXManagerStatus() {
    try {
      const res = await fetch("/api/xmanager/status");
      if (res.ok) {
        setXManagerStatus(await res.json());
      }
    } catch (error) {
      console.error("Failed to fetch X Manager status:", error);
    }
  }

  async function fetchXManagerConfig() {
    try {
      const res = await fetch("/api/settings/xmanager");
      if (res.ok) {
        const data = await res.json();
        if (data.config?.xUsername) {
          setXUsername(data.config.xUsername);
        }
        if (data.config?.modelId) {
          setModelId(data.config.modelId);
        }
      }
    } catch (error) {
      console.error("Failed to fetch X Manager config:", error);
    }
  }

  async function fetchAreasOfInterest() {
    try {
      const res = await fetch("/api/settings/xmanager/areas-of-interest");
      if (res.ok) {
        const data = await res.json();
        if (data.content) {
          setAreasOfInterest(data.content);
        }
      }
    } catch (error) {
      console.error("Failed to fetch areas of interest:", error);
    }
  }

  async function fetchEngagementCriteria() {
    try {
      const res = await fetch("/api/settings/xmanager/engagement-criteria");
      if (res.ok) {
        const data = await res.json();
        if (data.content) {
          setEngagementCriteria(data.content);
        }
      }
    } catch (error) {
      console.error("Failed to fetch engagement criteria:", error);
    }
  }

  useEffect(() => {
    async function fetchData() {
      await Promise.all([
        fetchXManagerStatus(),
        fetchXManagerConfig(),
        fetchAreasOfInterest(),
        fetchEngagementCriteria(),
      ]);
      setLoading(false);
    }
    fetchData();
  }, []);

  async function saveXManagerConfig() {
    if (!xUsername.trim()) {
      setXUsernameError("X username is required");
      setXUsernameStatus("error");
      return;
    }

    setXUsernameStatus("saving");
    setXUsernameError("");

    try {
      const res = await fetch("/api/settings/xmanager", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          xUsername: xUsername.trim(),
          modelId: modelId
        }),
      });

      const data = await res.json();

      if (res.ok) {
        setXUsernameStatus("success");
      } else {
        setXUsernameError(data.error || "Failed to save X Manager config");
        setXUsernameStatus("error");
      }
    } catch (err) {
      console.error("Failed to save X Manager config:", err);
      setXUsernameError("Network error");
      setXUsernameStatus("error");
    }
  }

  async function saveAreasOfInterest() {
    setAreasOfInterestStatus("saving");
    setAreasOfInterestError("");

    try {
      const res = await fetch("/api/settings/xmanager/areas-of-interest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: areasOfInterest }),
      });

      const data = await res.json();

      if (res.ok) {
        setAreasOfInterestStatus("success");
      } else {
        setAreasOfInterestError(data.error || "Failed to save areas of interest");
        setAreasOfInterestStatus("error");
      }
    } catch (err) {
      console.error("Failed to save areas of interest:", err);
      setAreasOfInterestError("Network error");
      setAreasOfInterestStatus("error");
    }
  }

  async function saveEngagementCriteria() {
    setEngagementCriteriaStatus("saving");
    setEngagementCriteriaError("");

    try {
      const res = await fetch("/api/settings/xmanager/engagement-criteria", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: engagementCriteria }),
      });

      const data = await res.json();

      if (res.ok) {
        setEngagementCriteriaStatus("success");
      } else {
        setEngagementCriteriaError(data.error || "Failed to save engagement criteria");
        setEngagementCriteriaStatus("error");
      }
    } catch (err) {
      console.error("Failed to save engagement criteria:", err);
      setEngagementCriteriaError("Network error");
      setEngagementCriteriaStatus("error");
    }
  }

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      {loading ? (
        <div className="text-center py-12 text-neutral-500">Loading...</div>
      ) : (
        <div className="space-y-8">
          {/* Status & Controls */}
          <section>
            <h2 className="text-lg font-medium mb-4">Status & Controls</h2>
            <div className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800">
              {/* Status Row */}
              <div className="flex items-center justify-between mb-6">
                <div className="flex items-center gap-3">
                  <div className="text-2xl">𝕏</div>
                  <div>
                    <div className="font-medium">X Engagement Manager</div>
                    <div className="text-sm text-neutral-500">
                      {xManagerStatus?.isRunning || xManagerRunning ? (
                        <span className="text-blue-600">Running...</span>
                      ) : xManagerStatus?.lastRun ? (
                        <>Last run: {new Date(xManagerStatus.lastRun.time).toLocaleString()}</>
                      ) : (
                        "Never run"
                      )}
                    </div>
                  </div>
                </div>
                <div
                  className={`px-2 py-1 rounded-full text-xs font-medium ${
                    xManagerStatus?.isRunning || xManagerRunning
                      ? "bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
                      : xManagerStatus?.lastRun
                      ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300"
                      : "bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400"
                  }`}
                >
                  {xManagerStatus?.isRunning || xManagerRunning
                    ? "Running"
                    : xManagerStatus?.lastRun
                    ? "Ready"
                    : "Not Run"}
                </div>
              </div>

              {/* Last Run Summary */}
              {xManagerStatus?.lastRun?.summary && (
                <div className="mb-6 p-3 rounded-lg bg-neutral-50 dark:bg-neutral-900">
                  <div className="text-sm text-neutral-600 dark:text-neutral-400">
                    {xManagerStatus.lastRun.summary}
                  </div>
                </div>
              )}

              {/* Next Scheduled Run */}
              {xManagerStatus?.nextScheduledRun && (
                <div className="mb-6 text-sm text-neutral-500">
                  Next scheduled run:{" "}
                  {new Date(xManagerStatus.nextScheduledRun.time).toLocaleString()}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3">
                <button
                  onClick={async () => {
                    if (xManagerRunning) return;
                    setXManagerRunning(true);
                    try {
                      const res = await fetch("/api/xmanager/run", { method: "POST" });
                      const data = await res.json();
                      if (res.ok) {
                        alert(
                          `X Manager completed!\n\nReplies found: ${data.summary?.repliesFound || 0}\nOpportunities found: ${data.summary?.opportunitiesFound || 0}`
                        );
                        await fetchXManagerStatus();
                      } else {
                        alert(`Failed: ${data.error || "Unknown error"}`);
                      }
                    } catch (error) {
                      alert("Error running X Manager");
                      console.error(error);
                    } finally {
                      setXManagerRunning(false);
                    }
                  }}
                  disabled={xManagerStatus?.isRunning || xManagerRunning}
                  className="px-4 py-2 bg-foreground text-background rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
                >
                  {xManagerRunning ? "Running..." : "Run Now"}
                </button>
                {(xManagerStatus?.isRunning || xManagerRunning) && (
                  <button
                    onClick={async () => {
                      if (
                        !confirm(
                          "Are you sure you want to cancel the running agent? This will clear the run lock."
                        )
                      ) {
                        return;
                      }
                      try {
                        const res = await fetch("/api/xmanager/cancel", {
                          method: "POST",
                        });
                        const data = await res.json();
                        if (res.ok) {
                          alert("Run cancelled successfully");
                          setXManagerRunning(false);
                          await fetchXManagerStatus();
                        } else {
                          alert(`Failed to cancel: ${data.error || "Unknown error"}`);
                        }
                      } catch (error) {
                        alert("Error cancelling X Manager");
                        console.error(error);
                      }
                    }}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 transition-colors"
                  >
                    Cancel Run
                  </button>
                )}
                <button
                  onClick={async () => {
                    const minutes = prompt(
                      "Schedule X Manager run in how many minutes?",
                      "60"
                    );
                    if (minutes) {
                      try {
                        const res = await fetch("/api/xmanager/schedule", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ minutesFromNow: parseInt(minutes) }),
                        });
                        if (res.ok) {
                          const data = await res.json();
                          alert(
                            `Scheduled for ${new Date(data.scheduledTime).toLocaleString()}`
                          );
                          await fetchXManagerStatus();
                        }
                      } catch {
                        alert("Error scheduling X Manager");
                      }
                    }
                  }}
                  className="px-4 py-2 border border-neutral-200 dark:border-neutral-700 rounded-lg text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
                >
                  Schedule Run
                </button>
                {xManagerStatus?.nextScheduledRun && (
                  <button
                    onClick={async () => {
                      try {
                        const res = await fetch("/api/xmanager/schedule", {
                          method: "DELETE",
                        });
                        if (res.ok) {
                          alert("Scheduled run cancelled");
                          await fetchXManagerStatus();
                        }
                      } catch {
                        alert("Error cancelling scheduled run");
                      }
                    }}
                    className="px-4 py-2 text-sm text-red-600 hover:text-red-700 transition-colors"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </section>

          {/* Configuration */}
          <section>
            <h2 className="text-lg font-medium mb-4">Configuration</h2>
            <div className="mb-4 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
              <div className="flex items-start justify-between gap-4">
                <p className="text-sm text-blue-800 dark:text-blue-200">
                  <strong>Browser Session:</strong> The agent uses a browser that must be logged into X as the target account. Click "Login to X" to open a browser window where you can log in manually. Your session will be saved for future runs.
                </p>
                <button
                  onClick={async () => {
                    if (loginStatus === "running") return;
                    setLoginStatus("running");
                    setLoginError("");
                    try {
                      const res = await fetch("/api/xmanager/login", { method: "POST" });
                      const data = await res.json();
                      if (res.ok) {
                        setLoginStatus("success");
                      } else {
                        setLoginError(data.error || "Login failed");
                        setLoginStatus("error");
                      }
                    } catch (error) {
                      setLoginError("Network error");
                      setLoginStatus("error");
                      console.error(error);
                    }
                  }}
                  disabled={loginStatus === "running"}
                  className="shrink-0 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
                >
                  {loginStatus === "running" ? "Opening Browser..." : "Login to X"}
                </button>
              </div>
              {loginStatus === "success" && (
                <p className="mt-2 text-sm text-green-600 dark:text-green-400">
                  Login flow completed! You should now be logged in.
                </p>
              )}
              {loginStatus === "error" && loginError && (
                <p className="mt-2 text-sm text-red-600 dark:text-red-400">
                  {loginError}
                </p>
              )}
            </div>
            <div className="p-6 rounded-lg border border-neutral-200 dark:border-neutral-800 space-y-6">
              {/* X Username */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  X Username
                </label>
                <p className="text-sm text-neutral-500 mb-3">
                  Your X/Twitter username (without the @ symbol). The agent will browse X logged in as this account to view notifications, analytics, and your feed.
                </p>
                <div className="flex gap-3">
                  <input
                    type="text"
                    value={xUsername}
                    onChange={(e) => {
                      setXUsername(e.target.value);
                      setXUsernameStatus("idle");
                    }}
                    placeholder="username"
                    className="flex-1 px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    onClick={saveXManagerConfig}
                    disabled={xUsernameStatus === "saving"}
                    className="px-4 py-2 text-sm bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {xUsernameStatus === "saving" ? "Saving..." : "Save"}
                  </button>
                </div>
                {xUsernameStatus === "success" && (
                  <div className="mt-2 text-sm text-green-600 dark:text-green-400">
                    X username saved successfully!
                  </div>
                )}
                {xUsernameStatus === "error" && xUsernameError && (
                  <div className="mt-2 text-sm text-red-600 dark:text-red-400">
                    {xUsernameError}
                  </div>
                )}
              </div>

              {/* Model Selection */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  AI Model
                </label>
                <p className="text-sm text-neutral-500 mb-3">
                  Select which AI model to use for XManager agents. GPT-5.2 has the most reliable reasoning support for multi-turn tool calling.
                </p>
                <select
                  value={modelId}
                  onChange={(e) => {
                    setModelId(e.target.value);
                    setXUsernameStatus("idle");
                  }}
                  className="w-full px-3 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="google/gemini-3-flash-preview">
                    Gemini 3 Flash Preview (Default) - Fast &amp; cost-effective with reasoning
                  </option>
                  <option value="google/gemini-3-pro-preview">
                    Gemini 3 Pro Preview - Flagship model with reasoning
                  </option>
                  <option value="openai/gpt-5.2-chat">
                    GPT-5.2 - OpenAI&apos;s latest reasoning model
                  </option>
                  <option value="anthropic/claude-sonnet-4.5">
                    Claude 4.5 Sonnet - Extended thinking (may have issues)
                  </option>
                </select>
                <p className="mt-2 text-xs text-neutral-400">
                  Model preference is saved with your username and used for all scheduled runs.
                </p>
              </div>

              {/* Areas of Interest */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  Areas of Interest
                </label>
                <p className="text-sm text-neutral-500 mb-3">
                  Define the topics and areas the agent should look for when scanning your X feed for engagement opportunities.
                </p>
                <textarea
                  value={areasOfInterest}
                  onChange={(e) => {
                    setAreasOfInterest(e.target.value);
                    setAreasOfInterestStatus("idle");
                  }}
                  rows={12}
                  className="w-full px-3 py-2 text-sm font-mono border border-neutral-200 dark:border-neutral-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                  placeholder="# Areas of Interest

Your company description and topic areas...

## Topic Areas

- Topic 1
- Topic 2
"
                />
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={saveAreasOfInterest}
                    disabled={areasOfInterestStatus === "saving"}
                    className="px-4 py-2 text-sm bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {areasOfInterestStatus === "saving" ? "Saving..." : "Save Areas of Interest"}
                  </button>
                  {areasOfInterestStatus === "success" && (
                    <span className="text-sm text-green-600 dark:text-green-400">
                      Saved successfully!
                    </span>
                  )}
                  {areasOfInterestStatus === "error" && areasOfInterestError && (
                    <span className="text-sm text-red-600 dark:text-red-400">
                      {areasOfInterestError}
                    </span>
                  )}
                </div>
              </div>

              {/* Engagement Criteria */}
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  Engagement Criteria
                </label>
                <p className="text-sm text-neutral-500 mb-3">
                  Define the criteria for prioritizing replies, selecting feed opportunities, and analyzing performance metrics.
                </p>
                <textarea
                  value={engagementCriteria}
                  onChange={(e) => {
                    setEngagementCriteria(e.target.value);
                    setEngagementCriteriaStatus("idle");
                  }}
                  rows={16}
                  className="w-full px-3 py-2 text-sm font-mono border border-neutral-200 dark:border-neutral-700 rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                  placeholder="### Reply Prioritization Criteria

Include all replies that are made directly to you, except:
- Simple acknowledgments
- Emoji-only responses
- Spam or promotional content

### Feed Opportunity Criteria

Include posts that match ALL of these:
1. **Topic Relevance**: Within the areas of interest
2. **Engagement Timing**: Posted within optimal window
3. **Thread Potential**: Has conversation potential
"
                />
                <div className="mt-3 flex items-center gap-3">
                  <button
                    onClick={saveEngagementCriteria}
                    disabled={engagementCriteriaStatus === "saving"}
                    className="px-4 py-2 text-sm bg-foreground text-background rounded-lg hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {engagementCriteriaStatus === "saving" ? "Saving..." : "Save Engagement Criteria"}
                  </button>
                  {engagementCriteriaStatus === "success" && (
                    <span className="text-sm text-green-600 dark:text-green-400">
                      Saved successfully!
                    </span>
                  )}
                  {engagementCriteriaStatus === "error" && engagementCriteriaError && (
                    <span className="text-sm text-red-600 dark:text-red-400">
                      {engagementCriteriaError}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
