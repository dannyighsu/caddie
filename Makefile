.PHONY: run dev debug debug-snapshot build build-harness install smoke google-auth

# Start the Northstar control plane in PRODUCTION mode (next build + next start).
# Use this for the long-lived process: `next start` has no Turbopack dev
# compiler, so memory stays flat/bounded. The dev server (`make dev`) leaks
# compiled-module strings over long uptime — see northstar/scripts/mem-logger.cjs.
# Override workspace: make run WORKSPACE_ROOT=/path/to/workspace
run: build
	@if command -v tailscale >/dev/null 2>&1; then \
		tailscale funnel 3000 &\
		echo "[Funnel] Exposing localhost:3000 via Tailscale Funnel"; \
	fi
	cd northstar && WORKSPACE_ROOT=$(or $(WORKSPACE_ROOT),$(CURDIR)/workspace) pnpm start

# Start the Northstar control plane with the Next dev server (hot reload).
# For active development only — do NOT leave running for hours; the Turbopack
# dev compiler accumulates memory over uptime (use `make run` for long sessions).
dev: build-harness
	cd northstar && WORKSPACE_ROOT=$(or $(WORKSPACE_ROOT),$(CURDIR)/workspace) pnpm dev

# Run the dev server with memory diagnostics (local only, no Funnel).
# Layers Node memory diagnostics on top of `make dev`:
#   --require .../mem-logger.cjs      periodic process.memoryUsage() + major-GC logging (per pid)
#   --heapsnapshot-near-heap-limit=2  dump up to 2 .heapsnapshot files as it nears OOM
#   --heapsnapshot-signal=SIGUSR2     dump a snapshot on demand: kill -USR2 <pid>
# Snapshots land in northstar/ — open them in Chrome DevTools -> Memory, sort by
# retained size. Tune logging cadence with DEBUG_MEM_INTERVAL_MS (ms).
debug: build-harness
	cd northstar && \
		WORKSPACE_ROOT=$(or $(WORKSPACE_ROOT),$(CURDIR)/workspace) \
		NODE_OPTIONS="--require $(CURDIR)/northstar/scripts/mem-logger.cjs --heapsnapshot-near-heap-limit=2 --heapsnapshot-signal=SIGUSR2" \
		pnpm dev

# Dump an on-demand heap snapshot of the running next-server worker (requires
# `make debug` running). Take one early and one after generating load, then diff
# them in Chrome DevTools -> Memory (Comparison view, sort by Size Delta).
# Snapshot files (Heap.*.heapsnapshot) are written into northstar/.
debug-snapshot:
	@pid=$$(pgrep -f "next-server" | head -1); \
	if [ -z "$$pid" ]; then \
		echo "No next-server process found — is \`make debug\` running?"; \
		exit 1; \
	fi; \
	echo "Sending SIGUSR2 to next-server (pid $$pid) — snapshot -> northstar/"; \
	kill -USR2 $$pid

# Build the harness package (produces harness/dist, which northstar imports as
# @agints/harness). Needed by both `make dev` and `make run`.
build-harness:
	cd harness && pnpm build

# Full production build: harness + northstar (next build). Needed by `make run`.
build: build-harness
	cd northstar && pnpm build

# Install all dependencies
install:
	pnpm install

# Run a quick smoke test via the harness directly
smoke:
	cd harness && pnpm smoke

# One-time Google Calendar OAuth setup (pulls env from northstar/.env.local)
google-auth:
	cd harness && env $$(grep -E '^GOOGLE_CLIENT' ../northstar/.env.local | xargs) npx tsx scripts/google-auth.ts
