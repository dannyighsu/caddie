/**
 * Next.js Instrumentation
 *
 * Runs once when the server starts. Used to initialize long-lived
 * connections like Slack Socket Mode.
 */

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Prefix every process log line with a timestamp. Installed first so all
    // subsequent startup logging (and the harness we import) is stamped too.
    const { installLogTimestamps } = await import("./lib/log-timestamps");
    installLogTimestamps();

    // Pre-flight health checks
    const { checkAllCapabilities } = await import("./lib/health");
    checkAllCapabilities().catch((err) =>
      console.error("[Health] Pre-flight check failed:", err)
    );

    // Start job scheduler
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();

    // Workspace search: mirror conversations into each agent's workspace and
    // keep its local index in sync (a no-op for the index without LOCAL_RAG_ENTRY).
    const { listAgents } = await import("./lib/harness");
    const { backfillMirror } = await import("./lib/conversation-mirror");
    const { startWorkspaceIndex } = await import("./lib/workspace-index");
    listAgents()
      .then((agents) => startWorkspaceIndex(agents.map((a) => a.id), backfillMirror))
      .catch((err) => console.error("[RagIndex] Startup failed:", err));

    // Start Slack Socket Mode
    const { startSocketMode } = await import("./lib/slack");
    const { handleSlackMessage } = await import("./lib/slack-handler");
    startSocketMode(handleSlackMessage);

    // Start Gmail inbound poller (replaces the AgentMail webhook)
    const { startGmailPoller } = await import("./lib/gmail/poller");
    startGmailPoller();

    // Telegram is webhook-based — no startup needed
  }
}
