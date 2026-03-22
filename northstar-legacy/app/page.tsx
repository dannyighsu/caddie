"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

interface ConnectionStatus {
  provider: string;
  connected: boolean;
  metadata?: Record<string, unknown>;
  connectedAt?: string;
}

interface NextCheckIn {
  scheduledTime: number;
  status: string;
}

export default function Dashboard() {
  const [connections, setConnections] = useState<Record<string, ConnectionStatus>>({});
  const [nextCheckIn, setNextCheckIn] = useState<NextCheckIn | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchStatus() {
      try {
        const [connectionsRes, checkInRes] = await Promise.all([
          fetch("/api/auth/status"),
          fetch("/api/scheduler/next"),
        ]);

        if (connectionsRes.ok) {
          setConnections(await connectionsRes.json());
        }

        if (checkInRes.ok) {
          const data = await checkInRes.json();
          setNextCheckIn(data.nextCheckIn || null);
        }
      } catch (error) {
        console.error("Failed to fetch status:", error);
      } finally {
        setLoading(false);
      }
    }

    fetchStatus();
  }, []);

  const connectedCount = Object.values(connections).filter(c => c.connected).length;

  return (
    <main className="max-w-4xl mx-auto px-6 py-8">
      {loading ? (
        <div className="text-center py-12 text-neutral-500">Loading...</div>
      ) : (
        <div className="space-y-8">
          {/* Status Overview */}
          <section>
            <h2 className="text-lg font-medium mb-4">Status</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="p-4 rounded-lg border border-neutral-200 dark:border-neutral-800">
                <div className="text-2xl font-semibold">{connectedCount}/2</div>
                <div className="text-sm text-neutral-500">Services Connected</div>
              </div>
              <div className="p-4 rounded-lg border border-neutral-200 dark:border-neutral-800">
                <div className="text-2xl font-semibold">
                  {nextCheckIn
                    ? new Date(nextCheckIn.scheduledTime).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "—"}
                </div>
                <div className="text-sm text-neutral-500">Next Check-in</div>
              </div>
              <div className="p-4 rounded-lg border border-neutral-200 dark:border-neutral-800">
                <div className="text-2xl font-semibold">
                  {connectedCount === 2 ? "Ready" : "Setup Required"}
                </div>
                <div className="text-sm text-neutral-500">Agent Status</div>
              </div>
            </div>
          </section>

          {/* Connected Services */}
          <section>
            <h2 className="text-lg font-medium mb-4">Connected Services</h2>
            <div className="space-y-3">
              {["google", "notion"].map((provider) => {
                const conn = connections[provider];
                return (
                  <div
                    key={provider}
                    className="p-4 rounded-lg border border-neutral-200 dark:border-neutral-800 flex items-center justify-between"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className={`w-2 h-2 rounded-full ${
                          conn?.connected ? "bg-green-500" : "bg-neutral-300"
                        }`}
                      />
                      <div>
                        <div className="font-medium capitalize">
                          {provider === "google" ? "Google Calendar" : "Notion"}
                        </div>
                        {conn?.connected && conn.metadata && (
                          <div className="text-sm text-neutral-500">
                            {provider === "google" && (conn.metadata.email as string)}
                            {provider === "notion" && (conn.metadata.workspace_name || conn.metadata.mode === "internal" ? "Internal Integration" : "")}
                          </div>
                        )}
                      </div>
                    </div>
                    <Link
                      href="/settings"
                      className="text-sm text-blue-600 hover:text-blue-700"
                    >
                      {conn?.connected ? "Manage" : "Connect"}
                    </Link>
                  </div>
                );
              })}
              {/* Slack - managed by ChatKit */}
              <div className="p-4 rounded-lg border border-neutral-200 dark:border-neutral-800 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-2 h-2 rounded-full bg-blue-500" />
                  <div>
                    <div className="font-medium">Slack</div>
                    <div className="text-sm text-neutral-500">Managed via ChatKit</div>
                  </div>
                </div>
                <Link
                  href="/settings"
                  className="text-sm text-blue-600 hover:text-blue-700"
                >
                  Setup
                </Link>
              </div>
            </div>
          </section>

          {/* Quick Actions */}
          <section>
            <h2 className="text-lg font-medium mb-4">Quick Actions</h2>
            <div className="flex gap-3">
              <button
                onClick={async () => {
                  try {
                    const res = await fetch("/api/agent/run", { method: "POST" });
                    if (res.ok) {
                      alert("Agent run triggered");
                    } else {
                      alert("Failed to trigger agent run");
                    }
                  } catch {
                    alert("Error triggering agent run");
                  }
                }}
                disabled={connectedCount < 2}
                className="px-4 py-2 bg-foreground text-background rounded-lg text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90 transition-opacity"
              >
                Run Check-in Now
              </button>
              <button
                onClick={async () => {
                  const time = prompt("Enter time for next check-in (HH:MM):");
                  if (time) {
                    const [hours, minutes] = time.split(":").map(Number);
                    const scheduledTime = new Date();
                    scheduledTime.setHours(hours, minutes, 0, 0);
                    if (scheduledTime < new Date()) {
                      scheduledTime.setDate(scheduledTime.getDate() + 1);
                    }
                    try {
                      const res = await fetch("/api/scheduler/schedule", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ scheduledTime: scheduledTime.toISOString() }),
                      });
                      if (res.ok) {
                        window.location.reload();
                      }
                    } catch {
                      alert("Error scheduling check-in");
                    }
                  }
                }}
                className="px-4 py-2 border border-neutral-200 dark:border-neutral-700 rounded-lg text-sm font-medium hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              >
                Schedule Check-in
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
