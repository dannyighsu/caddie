#!/usr/bin/env bash
#
# One-shot migration of an install from Ignis to Caddie. Delete this script once
# every install has run it.
#
# Stop the server and `git pull` first, then run this from the checkout:
#
#   bash scripts/migrate-ignis-to-caddie.sh --dry-run
#   bash scripts/migrate-ignis-to-caddie.sh
#
# Safe to re-run: each step skips itself once done. It migrates the Redis keys,
# the database name, the env files, the workspace and its transcripts, drops the
# search index (rebuilt at next start), and reinstalls dependencies. It then
# lists files that still mention the old name, because those need a person.
#
#   --dry-run    Report what would happen; change nothing.
#   --no-backup  Skip the Redis and Postgres dumps.

set -euo pipefail

DRY_RUN=0
BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-backup) BACKUP=0 ;;
    -h|--help) sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

ENV_FILE=portal/.env.local
AGENT_ENV=harness/agent/.env
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

say()  { printf '\n==> %s\n' "$*"; }
note() { printf '    %s\n' "$*"; }
warn() { printf '    WARNING: %s\n' "$*" >&2; }
die()  { printf '\nERROR: %s\nNothing further was changed.\n' "$*" >&2; exit 1; }
dry()  { [ "$DRY_RUN" = 1 ]; }

# Last assignment of $1 in file $2, without surrounding quotes.
env_get() {
  [ -f "$2" ] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1=//p" "$2" \
    | tail -1 | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# Claude Code's project directory name for a path.
encode_path() { printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/-/g'; }

is_empty_dir() { [ -d "$1" ] && [ -z "$(ls -A "$1")" ]; }

# Decide whether $1 -> $2 can move. Sets MOVE to 1 when it should.
check_move() {
  MOVE=0
  if [ -e "$1" ] && [ -e "$2" ]; then
    is_empty_dir "$2" || die "both $1 and $2 exist. Merge them by hand; this script won't overwrite either."
    MOVE=1
  elif [ -e "$1" ]; then
    MOVE=1
  fi
}

move() {
  if dry; then note "would move $1 -> $2"; return; fi
  if is_empty_dir "$2"; then rmdir "$2"; fi
  mv "$1" "$2"
  note "moved $1 -> $2"
}

# ---------------------------------------------------------------------------
# Preflight: everything that can refuse does so before anything changes.
# ---------------------------------------------------------------------------

say "Preflight"

grep -q 'caddie:jobs' portal/lib/redis.ts \
  || die "this checkout doesn't have the rename yet. Stop the server, git pull, then run this."

[ -f "$ENV_FILE" ] || die "$ENV_FILE not found. This script runs on an install."

for cmd in redis-cli pnpm; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is not on PATH."
done

if command -v tmux >/dev/null 2>&1; then
  for session in ignis caddie; do
    if tmux has-session -t "=$session" 2>/dev/null; then
      die "tmux session '$session' is running. Stop the server, then: tmux kill-session -t $session"
    fi
  done
fi

PORT=$(env_get CADDIE_PORT "$ENV_FILE")
[ -n "$PORT" ] || PORT=$(env_get IGNIS_PORT "$ENV_FILE")
PORT=${CADDIE_PORT:-${IGNIS_PORT:-${PORT:-3000}}}
if command -v lsof >/dev/null 2>&1; then
  for pid in $(lsof -ti "tcp:$PORT" -sTCP:LISTEN 2>/dev/null || true); do
    cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    case "$cwd" in
      "$REPO_ROOT"|"$REPO_ROOT"/*) die "this install's server is running on port $PORT (pid $pid). Stop it first." ;;
      *) note "port $PORT is held by another project ($cwd); ignoring it" ;;
    esac
  done
fi

REDIS_URL=$(env_get REDIS_URL "$ENV_FILE")
[ -n "$REDIS_URL" ] || die "REDIS_URL is not set in $ENV_FILE."
rcli() { redis-cli -u "$REDIS_URL" --no-auth-warning "$@"; }
[ "$(rcli PING 2>/dev/null || true)" = "PONG" ] || die "can't reach Redis at the REDIS_URL in $ENV_FILE."

OLD_WS="$HOME/.ignis"
NEW_WS="$HOME/.caddie"
RELOCATE_WS=1
REWRITE_WS_ENV=0
WS_SETTING=$(env_get WORKSPACE_DIR "$ENV_FILE")
if [ -n "$WS_SETTING" ]; then
  case "$WS_SETTING" in
    "~"|"~/"*) WS_EXPANDED="$HOME${WS_SETTING#\~}" ;;
    *) WS_EXPANDED="$WS_SETTING" ;;
  esac
  WS_EXPANDED=${WS_EXPANDED%/}
  if [ "$WS_EXPANDED" = "$OLD_WS" ]; then
    REWRITE_WS_ENV=1
  elif [ "$WS_EXPANDED" != "$NEW_WS" ]; then
    RELOCATE_WS=0
    NEW_WS="$WS_EXPANDED"
    note "WORKSPACE_DIR is custom ($WS_EXPANDED); leaving the workspace where it is"
  fi
fi

MOVE_WS=0
MOVE_PROJECTS=0
if [ "$RELOCATE_WS" = 1 ]; then
  check_move "$OLD_WS" "$NEW_WS"
  MOVE_WS=$MOVE
  OLD_PROJECTS="$HOME/.claude/projects/$(encode_path "$OLD_WS")"
  NEW_PROJECTS="$HOME/.claude/projects/$(encode_path "$NEW_WS")"
  check_move "$OLD_PROJECTS" "$NEW_PROJECTS"
  MOVE_PROJECTS=$MOVE
  if [ "$MOVE_WS" = 0 ] && [ ! -e "$NEW_WS" ]; then
    warn "no workspace at $OLD_WS or $NEW_WS"
  fi
fi

rcli --scan --pattern 'ignis:*' > "$TMP/keys"
KEY_COUNT=$(wc -l < "$TMP/keys" | tr -d ' ')
note "Redis keys to migrate: $KEY_COUNT"

PG_URL=$(env_get POSTGRES_URL "$ENV_FILE")
RENAME_DB=0
case "$PG_URL" in
  */ignis|*/ignis\?*) RENAME_DB=1 ;;
esac
note "Postgres database to rename: $([ "$RENAME_DB" = 1 ] && echo yes || echo no)"

# ---------------------------------------------------------------------------
# Backup
# ---------------------------------------------------------------------------

if [ "$BACKUP" = 1 ] && { [ "$KEY_COUNT" != 0 ] || [ "$RENAME_DB" = 1 ]; }; then
  BACKUP_DIR="$HOME/ignis-pre-rename-$(date +%Y%m%d-%H%M%S)"
  say "Backup to $BACKUP_DIR"
  if dry; then
    note "would dump Redis, Postgres and the env files"
  else
    (umask 077; mkdir "$BACKUP_DIR")
    rcli --rdb "$BACKUP_DIR/redis.rdb" >/dev/null \
      || die "Redis dump failed. Fix it, or re-run with --no-backup."
    if [ -n "$PG_URL" ]; then
      command -v pg_dump >/dev/null 2>&1 || die "pg_dump is not on PATH. Install it, or re-run with --no-backup."
      (umask 077; pg_dump "$PG_URL" > "$BACKUP_DIR/postgres.sql") \
        || die "Postgres dump failed. Fix it, or re-run with --no-backup."
    fi
    cp -p "$ENV_FILE" "$BACKUP_DIR/portal.env.local"
    if [ -f "$AGENT_ENV" ]; then cp -p "$AGENT_ENV" "$BACKUP_DIR/agent.env"; fi
    note "done"
  fi
fi

# ---------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------

say "Redis"
CONFLICTS=0
while IFS= read -r key; do
  [ -n "$key" ] || continue
  case "$key" in
    ignis:active:*)
      # Run locks. The server is down, so none of them is held.
      dry || rcli DEL "$key" >/dev/null
      ;;
    *)
      new="caddie:${key#ignis:}"
      if dry; then
        [ "$(rcli EXISTS "$new")" = 0 ] || { warn "$new already exists"; CONFLICTS=$((CONFLICTS + 1)); }
      elif [ "$(rcli RENAMENX "$key" "$new")" != 1 ]; then
        warn "kept $key: $new already exists"
        CONFLICTS=$((CONFLICTS + 1))
      fi
      ;;
  esac
done < "$TMP/keys"
if dry; then note "would migrate $KEY_COUNT keys"; else note "migrated $KEY_COUNT keys"; fi

# ---------------------------------------------------------------------------
# Postgres
# ---------------------------------------------------------------------------

say "Postgres"
if [ "$RENAME_DB" = 0 ]; then
  note "nothing to do"
elif dry; then
  note "would rename database ignis to caddie and update POSTGRES_URL"
elif ! command -v psql >/dev/null 2>&1; then
  warn "psql is not on PATH; keeping the database name 'ignis' (this still works)"
  RENAME_DB=0
else
  ADMIN_URL=$(printf '%s' "$PG_URL" | sed 's#/ignis\(?.*\)\{0,1\}$#/postgres\1#')
  if psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -q -c 'ALTER DATABASE ignis RENAME TO caddie;' >/dev/null; then
    note "renamed database ignis to caddie"
  else
    warn "couldn't rename the database; keeping 'ignis' (this still works). Re-run to retry."
    RENAME_DB=0
  fi
fi

# ---------------------------------------------------------------------------
# Env files
# ---------------------------------------------------------------------------

say "Env files"
if dry; then
  note "would rename IGNIS_* variables in $ENV_FILE and $AGENT_ENV, and update WORKSPACE_DIR and POSTGRES_URL if needed"
else
  for file in "$ENV_FILE" "$AGENT_ENV"; do
    if [ -f "$file" ]; then
      perl -pi -e 's/^(\s*(?:export\s+)?)IGNIS_/$1CADDIE_/' "$file"
    fi
  done
  if [ "$REWRITE_WS_ENV" = 1 ]; then
    perl -pi -e 's/^(\s*(?:export\s+)?)WORKSPACE_DIR=.*$/$1WORKSPACE_DIR=~\/.caddie/' "$ENV_FILE"
  fi
  if [ "$RENAME_DB" = 1 ]; then
    perl -pi -e 's#^(\s*(?:export\s+)?POSTGRES_URL=.*)/ignis(?=["\x27?]|\s*$)#$1/caddie#' "$ENV_FILE"
  fi
  note "done"
fi

# ---------------------------------------------------------------------------
# Workspace, transcripts, search index
# ---------------------------------------------------------------------------

say "Workspace"
if [ "$RELOCATE_WS" = 0 ]; then
  note "custom WORKSPACE_DIR; nothing to move"
else
  if [ "$MOVE_PROJECTS" = 1 ]; then
    move "$OLD_PROJECTS" "$NEW_PROJECTS"
  else
    note "no transcripts to move"
  fi
  if [ "$MOVE_WS" = 1 ]; then
    # The index stores absolute paths, and its manifest would call it current.
    # Dropping it before the move means an interrupted run can't keep it.
    if dry; then
      note "would drop the search index"
    else
      rm -rf "$OLD_WS/.rag/db" "$OLD_WS/.rag/manifest.json"
      note "dropped the search index; the next start rebuilds it"
    fi
    move "$OLD_WS" "$NEW_WS"
  else
    note "workspace already moved"
  fi
fi

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------

say "Dependencies"
if dry; then
  note "would run pnpm install"
else
  pnpm install --frozen-lockfile
fi

# ---------------------------------------------------------------------------
# What's left needs a person
# ---------------------------------------------------------------------------

say "Files that still mention the old name"
WS_NOW="$NEW_WS"
if dry && [ "$MOVE_WS" = 1 ]; then WS_NOW="$OLD_WS"; fi
: > "$TMP/hits"
for path in "$ENV_FILE" "$AGENT_ENV" harness/agent/PERSONA.md harness/agent/.claude \
            "$WS_NOW/config" "$WS_NOW/jobs" "$WS_NOW/state" "$WS_NOW/.claude" \
            "$HOME/.zshrc" "$HOME/.zprofile" "$HOME/.zshenv" "$HOME/.bashrc" "$HOME/.profile" \
            "$HOME/Library/LaunchAgents" "$HOME/.config/systemd/user"; do
  if [ -e "$path" ]; then
    grep -RIil ignis "$path" >> "$TMP/hits" 2>/dev/null || true
  fi
done
if crontab -l 2>/dev/null | grep -qi ignis; then echo "crontab" >> "$TMP/hits"; fi
JOBS_HASH=caddie:jobs
dry && JOBS_HASH=ignis:jobs
rcli HKEYS "$JOBS_HASH" 2>/dev/null > "$TMP/job_ids" || true
while IFS= read -r id; do
  [ -n "$id" ] || continue
  if rcli HGET "$JOBS_HASH" "$id" | grep -qi ignis; then
    echo "scheduled job $id (redis-cli HGET $JOBS_HASH $id)" >> "$TMP/hits"
  fi
done < "$TMP/job_ids"

if [ -s "$TMP/hits" ]; then
  while IFS= read -r hit; do note "$hit"; done < "$TMP/hits"
else
  note "none"
fi

# ---------------------------------------------------------------------------
# Result
# ---------------------------------------------------------------------------

if dry; then
  say "Dry run finished; nothing changed"
elif [ "$(rcli --scan --pattern 'ignis:*' | wc -l | tr -d ' ')" != 0 ]; then
  say "Finished with conflicts: some ignis:* keys remain ($CONFLICTS conflicts above)"
  note "A server may have started on the new code and written caddie:* keys."
  note "Compare the two and resolve them by hand, then re-run."
  exit 1
else
  say "Finished. Fix anything listed above, then: make run"
fi
if [ "$CONFLICTS" != 0 ]; then exit 1; fi
