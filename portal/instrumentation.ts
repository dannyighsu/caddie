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

    // Everything below resolves senders against the team roster, so it waits
    // for the roster to load rather than treating every member as a guest
    // while Postgres is unreachable. Not awaited: the portal UI serves meanwhile.
    const { waitForTeamRoster } = await import("./lib/team");
    waitForTeamRoster()
      .then(startListeners)
      .catch((err) => console.error("[Startup] Listeners failed to start:", err));
  }
}

/** The scheduler, workspace index and channel listeners. Started once the roster is loaded. */
async function startListeners() {
  // Start job scheduler
  const { startScheduler } = await import("./lib/scheduler");
  startScheduler();

  // Workspace search: mirror conversations into the workspace and keep its
  // local index in sync (a no-op for the index without LOCAL_RAG_ENTRY).
  const { backfillMirror } = await import("./lib/conversation-mirror");
  const { startWorkspaceIndex } = await import("./lib/workspace-index");
  startWorkspaceIndex(backfillMirror);

  // Start Slack Socket Mode
  const { startSocketMode } = await import("./lib/slack");
  const { handleSlackMessage } = await import("./lib/slack-handler");
  startSocketMode(handleSlackMessage);

  // Start Gmail inbound poller (replaces the AgentMail webhook)
  const { startGmailPoller } = await import("./lib/gmail/poller");
  startGmailPoller();

  // Telegram is webhook-based — no startup needed
}
