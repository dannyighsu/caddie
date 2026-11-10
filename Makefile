.PHONY: run serve pre-run dev debug debug-snapshot build build-harness install agent-tools smoke team-add slack-app google-auth gog-auth expose unexpose keep-awake allow-sleep rag-setup rag-rebuild

# Network exposure (see the "Network exposure" section in README.md).
CADDIE_PORT  ?= 3000
TAILNET_PORT ?= 8443
# Paths reachable from the PUBLIC internet via Tailscale Funnel. Everything else
# is served to the tailnet + localhost only. Keep this list minimal — it is the
# entire public attack surface.
FUNNEL_PATHS := /api/telegram/webhook /api/chat/plugins/slack/interactions

# Start the Caddie control plane in PRODUCTION mode (next build + next start).
# Use this for the long-lived process: `next start` has no Turbopack dev
# compiler, so memory stays flat/bounded. The dev server (`make dev`) leaks
# compiled-module strings over long uptime — see portal/scripts/mem-logger.cjs.
# Workspace defaults to ~/.caddie; override with make run WORKSPACE_DIR=/path
#
# `make run` wraps `make serve` in a tmux session (TMUX_SESSION, default
# "caddie") so the server outlives the terminal. Detach with C-b d, reattach
# with `tmux attach -t caddie`. If the session already exists, its run is
# stopped (C-c, wait for the port to free) and replaced with a fresh one — so
# `make run` doubles as "restart". Runs in the foreground when tmux is
# missing, when already inside tmux, or with `make run TMUX_SESSION=`.
TMUX_SESSION ?= caddie
run:
	@if [ -z "$(TMUX_SESSION)" ] || [ -n "$$TMUX" ] || ! command -v tmux >/dev/null 2>&1; then \
		exec $(MAKE) --no-print-directory serve; \
	fi; \
	if tmux has-session -t "=$(TMUX_SESSION)" 2>/dev/null; then \
		echo "[run] stopping existing run in tmux session '$(TMUX_SESSION)'…"; \
		tmux send-keys -t "=$(TMUX_SESSION):" C-c; \
		for i in 1 2 3 4 5 6 7 8 9 10; do \
			lsof -ti tcp:$(CADDIE_PORT) -sTCP:LISTEN >/dev/null 2>&1 || break; \
			sleep 1; \
		done; \
		tmux kill-session -t "=$(TMUX_SESSION)" 2>/dev/null || true; \
	fi; \
	tmux new-session -d -s "$(TMUX_SESSION)" -c "$(CURDIR)" \
		"$(MAKE) --no-print-directory serve $(if $(WORKSPACE_DIR),WORKSPACE_DIR=$(WORKSPACE_DIR)); echo '[run] server exited.'; exec \$$SHELL"; \
	echo "[run] started tmux session '$(TMUX_SESSION)'."; \
	if [ -t 1 ]; then exec tmux attach -t "=$(TMUX_SESSION)"; \
	else echo "[run] no TTY — attach with: tmux attach -t $(TMUX_SESSION)"; fi

# The actual production server (what `make run` runs inside tmux).
serve: pre-run build
	@$(MAKE) --no-print-directory expose
	cd portal && pnpm start

# This install's own steps before every run, such as syncing its skills: the
# executable harness/agent/pre-run, untracked, run from the repo root. See
# harness/agent/pre-run.example. A failing hook is reported and the run goes
# ahead, so a broken step can't keep the agent down.
PRE_RUN := harness/agent/pre-run
pre-run:
	@if [ -x $(PRE_RUN) ]; then \
		echo "[pre-run] running $(PRE_RUN)…"; \
		./$(PRE_RUN) || echo "[pre-run] WARN: $(PRE_RUN) exited $$?; starting anyway."; \
	elif [ -e $(PRE_RUN) ]; then \
		echo "[pre-run] WARN: $(PRE_RUN) is not executable; skipped (chmod +x it)."; \
	fi

# Configure the network surface via Tailscale, enforced at the proxy BEFORE any
# request reaches Next:
#   • PUBLIC internet → only FUNNEL_PATHS (ingress webhooks), Funnel on :443
#   • TAILNET + local → the full control plane, Serve on :$(TAILNET_PORT)
# localhost:$(CADDIE_PORT) is always reachable directly on this machine.
# Idempotent; config persists (Tailscale --bg) until `make unexpose`.
expose:
	@if ! command -v tailscale >/dev/null 2>&1; then \
		echo "[expose] tailscale not found — control plane stays localhost-only; webhooks unreachable from the internet."; \
		exit 0; \
	fi
	@echo "[expose] Clearing previous serve/funnel config…"
	@tailscale serve reset >/dev/null 2>&1 || true
	@echo "[expose] Tailnet-only (private): full control plane on :$(TAILNET_PORT)"
	@tailscale serve --bg --https=$(TAILNET_PORT) http://127.0.0.1:$(CADDIE_PORT) >/dev/null \
		|| echo "[expose] WARN: serve setup failed."
	@for p in $(FUNNEL_PATHS); do \
		echo "[expose] Public (Funnel :443): $$p"; \
		tailscale funnel --bg --yes --https=443 --set-path=$$p http://127.0.0.1:$(CADDIE_PORT)$$p >/dev/null \
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

# Keep this Mac running with the lid closed, so the agent stays reachable. One
# system-wide pmset flag that stops all sleep — idle and lid — until
# `make allow-sleep`, and survives a reboot. macOS only; see docs/SETUP.md.
keep-awake:
	@test "$$(uname)" = Darwin || { echo "[keep-awake] macOS only — see docs/SETUP.md for Linux."; exit 1; }
	sudo pmset -a disablesleep 1
	@pmset -g | grep -i sleepdisabled || true

allow-sleep:
	@test "$$(uname)" = Darwin || { echo "[allow-sleep] macOS only."; exit 1; }
	sudo pmset -a disablesleep 0
	@pmset -g | grep -i sleepdisabled || true

# Start the Caddie control plane with the Next dev server (hot reload).
# For active development only — do NOT leave running for hours; the Turbopack
# dev compiler accumulates memory over uptime (use `make run` for long sessions).
dev: build-harness
	cd portal && pnpm dev

# Run the dev server with memory diagnostics (local only, no Funnel).
# Layers Node memory diagnostics on top of `make dev`:
#   --require .../mem-logger.cjs      periodic process.memoryUsage() + major-GC logging (per pid)
#   --heapsnapshot-near-heap-limit=2  dump up to 2 .heapsnapshot files as it nears OOM
#   --heapsnapshot-signal=SIGUSR2     dump a snapshot on demand: kill -USR2 <pid>
# Snapshots land in portal/ — open them in Chrome DevTools -> Memory, sort by
# retained size. Tune logging cadence with DEBUG_MEM_INTERVAL_MS (ms).
debug: build-harness
	cd portal && \
		NODE_OPTIONS="--require $(CURDIR)/portal/scripts/mem-logger.cjs --heapsnapshot-near-heap-limit=2 --heapsnapshot-signal=SIGUSR2" \
		pnpm dev

# Dump an on-demand heap snapshot of the running next-server worker (requires
# `make debug` running). Take one early and one after generating load, then diff
# them in Chrome DevTools -> Memory (Comparison view, sort by Size Delta).
# Snapshot files (Heap.*.heapsnapshot) are written into portal/.
debug-snapshot:
	@pid=$$(pgrep -f "next-server" | head -1); \
	if [ -z "$$pid" ]; then \
		echo "No next-server process found — is \`make debug\` running?"; \
		exit 1; \
	fi; \
	echo "Sending SIGUSR2 to next-server (pid $$pid) — snapshot -> portal/"; \
	kill -USR2 $$pid

# Build the harness package (produces harness/dist, which the portal imports as
# @caddie/harness). Needed by both `make dev` and `make run`.
build-harness:
	cd harness && pnpm build

# Full production build: harness + portal (next build). Needed by `make run`.
build: build-harness
	cd portal && pnpm build

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

# Workspace search (the `local-rag` capability): clone/build the mcp-local-rag
# server beside this repo and print the LOCAL_RAG_ENTRY line for .env.local.
# Idempotent. The portal builds and maintains the index itself once restarted.
rag-setup:
	portal/scripts/setup-rag.sh

# Drop and rebuild the search index — after an embedding-model change or a
# workspace move (portal health says when). Asks the running portal to do it,
# so it can't race a sync; with the portal down, deletes the index and the next
# start rebuilds it.
rag-rebuild:
	@if curl -sf -o /dev/null http://localhost:$(CADDIE_PORT)/api/control; then \
		echo "[rag-rebuild] asking the portal to rebuild the index (this can take a while)…"; \
		curl -sS -X POST http://localhost:$(CADDIE_PORT)/api/control \
			-H 'Content-Type: application/json' -d '{"action":"rag_rebuild"}'; echo; \
	else \
		ws="$${WORKSPACE_DIR:-$$HOME/.caddie}"; case "$$ws" in "~"*) ws="$$HOME$${ws#\~}";; esac; \
		rm -rf "$$ws/.rag/db" "$$ws/.rag/manifest.json"; \
		echo "[rag-rebuild] portal not running — removed $$ws/.rag/db; the next start rebuilds it."; \
	fi

# Add a team member without a browser (the portal's /settings does the same):
#   make team-add NAME="Alex" EMAIL="alex@example.com,alt@example.com" [SLACK=U0123] [TELEGRAM=123] [ID=alex] [OWNER=1]
# The first member added is the owner. Restart a running portal afterwards.
team-add:
	@test -n "$(NAME)" || { echo 'usage: make team-add NAME="Alex" EMAIL="alex@example.com" [SLACK=…] [TELEGRAM=…] [ID=…] [OWNER=1]'; exit 1; }
	cd portal && node --no-warnings scripts/team-add.ts --name "$(NAME)" \
		$(if $(EMAIL),--email "$(EMAIL)") $(if $(SLACK),--slack "$(SLACK)") \
		$(if $(TELEGRAM),--telegram "$(TELEGRAM)") $(if $(ID),--id "$(ID)") $(if $(OWNER),--owner)

# Print a link that creates the Slack app from portal/slack-app-manifest.yml.
# Comment lines are stripped to keep the URL short.
slack-app:
	@node -e 'const yaml = require("fs").readFileSync("portal/slack-app-manifest.yml", "utf8").replace(/^\s*#.*\n/gm, ""); console.log("https://api.slack.com/apps?new_app=1&manifest_yaml=" + encodeURIComponent(yaml))'

# Run a quick smoke test via the harness directly
smoke:
	cd harness && pnpm smoke

# One-time Google Calendar OAuth setup (pulls env from portal/.env.local)
google-auth:
	cd harness && env $$(grep -E '^GOOGLE_CLIENT' ../portal/.env.local | xargs) npx tsx scripts/google-auth.ts

# One-time Google Sheets/Docs/Slides auth for the gog CLI (the agent's
# google-workspace skill). Reuses the OAuth client in portal/.env.local; gog
# keeps the token in the OS keyring. Scopes: Sheets, Docs, Slides + Drive
# limited to files gog creates or opens. Uses the manual flow with the client's
# registered redirect URI (localhost:3456, shared with google-auth) so no extra
# URI needs registering in Google Cloud.
#   make gog-auth ACCOUNT=agent@example.com
gog-auth:
	@test -n "$(ACCOUNT)" || { echo "usage: make gog-auth ACCOUNT=<the agent's Google account>"; exit 1; }
	@command -v gog >/dev/null || { echo "gog not found: brew install openclaw/tap/gogcli"; exit 1; }
	@creds=$$(mktemp); trap 'rm -f "$$creds"' EXIT; \
	id=$$(grep -E '^GOOGLE_CLIENT_ID=' portal/.env.local | cut -d= -f2- | tr -d "\"'"); \
	secret=$$(grep -E '^GOOGLE_CLIENT_SECRET=' portal/.env.local | cut -d= -f2- | tr -d "\"'"); \
	printf '{"installed":{"client_id":"%s","client_secret":"%s","auth_uri":"https://accounts.google.com/o/oauth2/auth","token_uri":"https://oauth2.googleapis.com/token","redirect_uris":["http://localhost"]}}' "$$id" "$$secret" > "$$creds"; \
	gog auth credentials set "$$creds" && \
	echo "After approving, the browser lands on a localhost:3456 page that won't load; paste that full URL here." && \
	gog auth add "$(ACCOUNT)" --services sheets,docs,slides,drive --drive-scope file \
		--manual --redirect-uri http://localhost:3456/oauth2callback && \
	gog auth doctor --check
