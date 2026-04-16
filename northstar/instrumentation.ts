/**
 * Next.js Instrumentation
 *
 * Runs once when the server starts. Used to initialize long-lived
 * connections like Slack Socket Mode.
 */

export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Pre-flight health checks
    const { checkAllCapabilities } = await import("./lib/health");
    checkAllCapabilities().catch((err) =>
      console.error("[Health] Pre-flight check failed:", err)
    );

    // Start job scheduler
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();

    // Start Slack Socket Mode
    const { startSocketMode } = await import("./lib/slack");
    const { handleSlackMessage } = await import("./lib/slack-handler");
    startSocketMode(handleSlackMessage);

    // Telegram and Email are webhook-based — no startup needed
  }
}
