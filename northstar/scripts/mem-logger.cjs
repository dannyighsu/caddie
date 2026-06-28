/**
 * Memory logger — diagnostic preload for `make debug`.
 *
 * Loaded via NODE_OPTIONS=--require, so it runs in every Node process that
 * inherits NODE_OPTIONS — the `next dev` parent, its server worker, build
 * workers, AND the `claude` agent subprocesses the harness spawns (env is
 * inherited). Each line is tagged with a role so you can ignore the noise:
 *   server — the next-server worker (the one that grows; watch this)
 *   agent  — a spawned claude CLI run (cwd under the workspace)
 *   child  — pnpm / next-cli / build workers (short-lived, ignorable)
 * Filter with: `make debug 2>&1 | grep ' server '`
 *
 * Logs process.memoryUsage() on an interval. A steady, monotonic rise in
 * rss/heapUsed across idle periods points at uptime accumulation (e.g. the dev
 * server holding module/compiler state) rather than a per-run spike.
 *
 * Also logs major (mark-compact) GC events via perf_hooks. These are the
 * expensive, stop-the-world collections; a burst of them recovering little
 * memory is the death-spiral signature of an OOM. (`--trace-gc` would show the
 * same thing but isn't allowed in NODE_OPTIONS, so we observe it in-process.)
 *
 * Env:
 *   DEBUG_MEM_INTERVAL_MS  — log cadence in ms (default 15000)
 *
 * Not loaded by `make run` — purely opt-in via `make debug`.
 */

const { PerformanceObserver, constants } = require("perf_hooks");

const intervalMs = Number(process.env.DEBUG_MEM_INTERVAL_MS) || 15000;
const startedAt = Date.now();
const mb = (n) => (n / 1024 / 1024).toFixed(1).padStart(7);
const upMin = () => ((Date.now() - startedAt) / 60000).toFixed(1);

// Classify this process so the (noisy, multi-process) output is scannable.
// Evaluated lazily — process.title isn't set to "next-server" until Next boots.
function role() {
  if (process.cwd().includes("/workspace/")) return "agent";
  if ((process.title || "").includes("next-server")) return "server";
  return "child";
}

function log() {
  const m = process.memoryUsage();
  console.log(
    `[mem ${role().padEnd(6)} pid=${process.pid} +${upMin()}m] ` +
      `rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB ` +
      `heapTotal=${mb(m.heapTotal)}MB external=${mb(m.external)}MB ` +
      `arrayBuffers=${mb(m.arrayBuffers)}MB`
  );
}

// Log major (mark-compact) GCs with their pause duration. Minor scavenges are
// skipped to keep the output readable.
const gcObserver = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    if (entry.detail && entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) {
      const heap = mb(process.memoryUsage().heapUsed);
      console.log(
        `[gc  ${role().padEnd(6)} pid=${process.pid} +${upMin()}m] major mark-compact ` +
          `${entry.duration.toFixed(1)}ms -> heapUsed=${heap}MB`
      );
    }
  }
});
gcObserver.observe({ entryTypes: ["gc"] });

// Don't keep the event loop alive solely for logging.
setInterval(log, intervalMs).unref();
log();
