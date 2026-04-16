.PHONY: run build install smoke google-auth

# Start the Northstar control plane + gateway
# Override workspace: make run WORKSPACE_ROOT=/path/to/workspace
run: build
	@if command -v tailscale >/dev/null 2>&1; then \
		tailscale funnel 3000 &\
		echo "[Funnel] Exposing localhost:3000 via Tailscale Funnel"; \
	fi
	cd northstar && WORKSPACE_ROOT=$(or $(WORKSPACE_ROOT),$(CURDIR)/workspace) pnpm dev

# Build both packages
build:
	cd harness && pnpm build
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
