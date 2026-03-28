.PHONY: run build install smoke

# Start the Northstar control plane + gateway
# Override workspace: make run WORKSPACE_ROOT=/path/to/workspace
run:
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
