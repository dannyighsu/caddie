.PHONY: run dev debug debug-snapshot build build-harness install agent-tools smoke google-auth gog-auth expose unexpose

# Network exposure (see the "Network exposure" section in README.md).
NORTHSTAR_PORT ?= 3000
TAILNET_PORT   ?= 8443
# Paths reachable from the PUBLIC internet via Tailscale Funnel. Everything else
# is served to the tailnet + localhost only. Keep this list minimal — it is the
# entire public attack surface.
FUNNEL_PATHS := /api/telegram/webhook /api/email/webhook

# Start the Northstar control plane in PRODUCTION mode (next build + next start).
# Use this for the long-lived process: `next start` has no Turbopack dev
# compiler, so memory stays flat/bounded. The dev server (`make dev`) leaks
# compiled-module strings over long uptime — see northstar/scripts/mem-logger.cjs.
# Override workspace: make run WORKSPACE_ROOT=/path/to/workspace
run: build
	@$(MAKE) --no-print-directory expose
	cd northstar && WORKSPACE_ROOT=$(or $(WORKSPACE_ROOT),$(CURDIR)/workspace) pnpm start

# Configure the network surface via Tailscale, enforced at the proxy BEFORE any
# request reaches Next:
#   • PUBLIC internet → only FUNNEL_PATHS (ingress webhooks), Funnel on :443
#   • TAILNET + local → the full control plane, Serve on :$(TAILNET_PORT)
# localhost:$(NORTHSTAR_PORT) is always reachable directly on this machine.
# Idempotent; config persists (Tailscale --bg) until `make unexpose`.
expose:
	@if ! command -v tailscale >/dev/null 2>&1; then \
		echo "[expose] tailscale not found — control plane stays localhost-only; webhooks unreachable from the internet."; \
		exit 0; \
	fi
	@echo "[expose] Clearing previous serve/funnel config…"
	@tailscale serve reset >/dev/null 2>&1 || true
	@echo "[expose] Tailnet-only (private): full control plane on :$(TAILNET_PORT)"
	@tailscale serve --bg --https=$(TAILNET_PORT) http://127.0.0.1:$(NORTHSTAR_PORT) >/dev/null \
		|| echo "[expose] WARN: serve setup failed."
	@for p in $(FUNNEL_PATHS); do \
		echo "[expose] Public (Funnel :443): $$p"; \
		tailscale funnel --bg --yes --https=443 --set-path=$$p http://127.0.0.1:$(NORTHSTAR_PORT)$$p >/dev/null \
			|| echo "[expose] WARN: funnel failed for $$p — is Funnel enabled for this node? https://tailscale.com/kb/1223/funnel"; \
	done
	@echo "[expose] Public surface = $(FUNNEL_PATHS); everything else is tailnet-only."

# Tear down all Tailscale serve/funnel exposure for this node.
unexpose:
	@if command -v tailscale >/dev/null 2>&1; then \
		tailscale serve reset && echo "[unexpose] Cleared all serve/funnel config for this node."; \
	else \
		echo "[unexpose] tailscale not found; nothing to clear."; \
	fi

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

# Host tools the agent uses from Bash. Runs go straight onto this machine (no
# container), so anything the agent needs has to be installed here:
#   • poppler — pdftoppm (the Read tool's PDF path shells out to it), pdftotext
#   • pypdf, in harness/.agent-venv — reads encrypted PDFs (empty user password)
#     that poppler-less inflation silently reads as blank. A venv because system
#     pip refuses installs under PEP 668; the runtime puts its bin/ first on the
#     agent's PATH. Idempotent — re-run to pick up additions.
AGENT_VENV := harness/.agent-venv
AGENT_PY_PACKAGES := pypdf
agent-tools:
	@if command -v pdftoppm >/dev/null 2>&1; then echo "[agent-tools] poppler already installed"; \
	elif command -v brew >/dev/null 2>&1; then brew install poppler; \
	elif command -v apt-get >/dev/null 2>&1; then sudo apt-get install -y poppler-utils; \
	else echo "[agent-tools] install poppler (pdftoppm) manually"; exit 1; fi
	@test -x $(AGENT_VENV)/bin/python3 || python3 -m venv $(AGENT_VENV)
	$(AGENT_VENV)/bin/pip install --quiet --upgrade $(AGENT_PY_PACKAGES)
	@$(AGENT_VENV)/bin/python3 -c "import pypdf; print('[agent-tools] pypdf', pypdf.__version__)"
	@pdftoppm -v 2>&1 | head -1

# Run a quick smoke test via the harness directly
smoke:
	cd harness && pnpm smoke

# One-time Google Calendar OAuth setup (pulls env from northstar/.env.local)
google-auth:
	cd harness && env $$(grep -E '^GOOGLE_CLIENT' ../northstar/.env.local | xargs) npx tsx scripts/google-auth.ts

# One-time Google Sheets/Docs/Slides auth for the gog CLI (the agent's
# google-workspace skill). Reuses the OAuth client in northstar/.env.local; gog
# keeps the token in the OS keyring. Scopes: Sheets, Docs, Slides + Drive
# limited to files gog creates or opens. Uses the manual flow with the client's
# registered redirect URI (localhost:3456, shared with google-auth) so no extra
# URI needs registering in Google Cloud.
#   make gog-auth ACCOUNT=agent@example.com
gog-auth:
	@test -n "$(ACCOUNT)" || { echo "usage: make gog-auth ACCOUNT=<the agent's Google account>"; exit 1; }
	@command -v gog >/dev/null || { echo "gog not found: brew install openclaw/tap/gogcli"; exit 1; }
	@creds=$$(mktemp); trap 'rm -f "$$creds"' EXIT; \
	id=$$(grep -E '^GOOGLE_CLIENT_ID=' northstar/.env.local | cut -d= -f2- | tr -d "\"'"); \
	secret=$$(grep -E '^GOOGLE_CLIENT_SECRET=' northstar/.env.local | cut -d= -f2- | tr -d "\"'"); \
	printf '{"installed":{"client_id":"%s","client_secret":"%s","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","redirect_uris":["http://localhost"]}}' "$$id" "$$secret" > "$$creds"; \
	gog auth credentials set "$$creds" && \
	echo "After approving, the browser lands on a localhost:3456 page that won't load; paste that full URL here." && \
	gog auth add "$(ACCOUNT)" --services sheets,docs,slides,drive --drive-scope file \
		--manual --redirect-uri http://localhost:3456/oauth2callback && \
	gog auth doctor --check
