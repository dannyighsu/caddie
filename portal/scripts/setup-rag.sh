#!/usr/bin/env bash
set -euo pipefail

# setup-rag.sh — build the local search server behind the `local-rag`
# capability and the portal's workspace indexer (`make rag-setup`).
#
# Idempotently:
#   1. checks prerequisites (node >= 22, pnpm, git)
#   2. clones or reuses the mcp-local-rag checkout beside this repo
#      (the MatildaAI fork, the same one ../library uses), then builds it
#   3. prints the LOCAL_RAG_ENTRY line for portal/.env.local
#
# The index itself is built by the portal. Restart it (`make run`) and it
# mirrors every conversation into the workspace and indexes it. The embedding
# model (~90 MB) downloads into <workspace>/.rag/models on the first sync.
#
# Env overrides:
#   SERVER_DIR   where the mcp-local-rag checkout lives (default: ../mcp-local-rag)
#   SERVER_REPO  / SERVER_REF   fork and branch (default: MatildaAI/mcp-local-rag, main)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SERVER_REPO="${SERVER_REPO:-https://github.com/MatildaAI/mcp-local-rag.git}"
SERVER_REF="${SERVER_REF:-main}"
SERVER_DIR="${SERVER_DIR:-$(dirname "$REPO_ROOT")/mcp-local-rag}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { echo "    $*"; }
die()  { echo "rag-setup: $*" >&2; exit 1; }

step "Checking prerequisites"
command -v git  >/dev/null || die "git not found"
command -v node >/dev/null || die "node not found — install Node 22+"
command -v pnpm >/dev/null || die "pnpm not found"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "node $(node -v) is too old — mcp-local-rag needs >= 22"

step "Setting up mcp-local-rag at $SERVER_DIR"
if [[ -d "$SERVER_DIR/.git" ]]; then
    info "reusing existing checkout"
    # Never clobber someone's working copy: only fast-forward a clean checkout
    # that's sitting on a branch.
    if [[ -n "$(git -C "$SERVER_DIR" status --porcelain)" ]]; then
        info "local changes present — leaving the checkout as-is"
    elif git -C "$SERVER_DIR" symbolic-ref -q HEAD >/dev/null; then
        git -C "$SERVER_DIR" pull --quiet --ff-only || info "could not fast-forward — continuing with what's checked out"
    else
        info "detached HEAD — leaving the checkout as-is"
    fi
else
    info "cloning $SERVER_REPO"
    git clone --quiet --branch "$SERVER_REF" "$SERVER_REPO" "$SERVER_DIR"
fi
info "server at $(git -C "$SERVER_DIR" log -1 --format='%h %s')"

info "installing dependencies (pulls the embedding runtime — a few minutes the first time)"
(cd "$SERVER_DIR" && pnpm install --frozen-lockfile)
info "building"
(cd "$SERVER_DIR" && pnpm run build)

ENTRY="$SERVER_DIR/dist/index.js"
[[ -f "$ENTRY" ]] || die "build produced no $ENTRY"

step "Done"
if grep -q "^LOCAL_RAG_ENTRY=$ENTRY\$" "$REPO_ROOT/portal/.env.local" 2>/dev/null; then
    info "portal/.env.local already has LOCAL_RAG_ENTRY — restart the portal (make run)."
else
    info "Add this to portal/.env.local, then restart the portal (make run):"
    echo
    echo "    LOCAL_RAG_ENTRY=$ENTRY"
fi
