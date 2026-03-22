export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Initialize Langfuse tracing first (before other imports that may trigger traces)
    const { initializeLangfuse } = await import("./lib/tracing/langfuse");
    initializeLangfuse();

    // Clear any stale state from previous server instances
    const { clearAllActiveRuns, clearAllPendingCheckIns } = await import("./lib/clients/redis-client");
    await clearAllActiveRuns();
    await clearAllPendingCheckIns();

    // Start the polling scheduler for check-ins
    const { startScheduler } = await import("./lib/scheduler/polling-scheduler");
    startScheduler();
  }
}
