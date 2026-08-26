---
name: repo-mount
description: Mount a local or remote git repo into the workspace temporarily so you can read, grep, and explore it. Mounts expire and are swept automatically. Use when the user asks you to look at a repo, clone a repo, or add access to a codebase.
---

## Repo Mounts

You have a `mounts/` directory in your workspace for temporary access to git repos — either existing local clones on the user's machine or remote URLs that get cloned in. Mounts have an expiry (default 24h) and a SessionStart hook sweeps expired ones at the start of every run.

**Mount layout:**
- `mounts/<name>/` — the repo itself (symlink for local, directory for clones)
- `mounts/.meta/<name>.json` — sidecar with `name`, `kind`, `source`, `mountedAt`, `expiresAt`

**Choose a short, kebab-case `<name>`** — the directory name the user will see when you reference paths. Usually derived from the repo name (e.g. `agints`, `northstar-legacy`).

## Mount a local repo (symlink)

When the user points you at a path on their machine:

```bash
SRC="/abs/path/to/repo"
NAME="repo-name"
TTL_HOURS=24

mkdir -p mounts/.meta
ln -s "$SRC" "mounts/$NAME"
python3 -c "
import json, datetime
now = datetime.datetime.now(datetime.timezone.utc)
exp = now + datetime.timedelta(hours=$TTL_HOURS)
json.dump({
    'name': '$NAME',
    'kind': 'symlink',
    'source': '$SRC',
    'mountedAt': now.isoformat(),
    'expiresAt': exp.isoformat(),
}, open('mounts/.meta/$NAME.json', 'w'), indent=2)
"
```

The symlink is instant and uses no storage. The underlying repo is **not** modified by sweep — sweep only removes the symlink.

## Mount a remote repo (shallow clone)

When the user gives you a git URL:

```bash
URL="https://github.com/org/repo"
NAME="repo"
TTL_HOURS=24

mkdir -p mounts/.meta
git clone --depth=1 "$URL" "mounts/$NAME"
python3 -c "
import json, datetime
now = datetime.datetime.now(datetime.timezone.utc)
exp = now + datetime.timedelta(hours=$TTL_HOURS)
json.dump({
    'name': '$NAME',
    'kind': 'clone',
    'source': '$URL',
    'mountedAt': now.isoformat(),
    'expiresAt': exp.isoformat(),
}, open('mounts/.meta/$NAME.json', 'w'), indent=2)
"
```

Use `--depth=1` by default to keep clones small. If the user asks for full history, drop the flag.

## List mounts

```bash
ls mounts/.meta/ 2>/dev/null | sed 's/\.json$//' || echo "(no mounts)"
```

Or for details including expiry:

```bash
for f in mounts/.meta/*.json; do [ -e "$f" ] && cat "$f" && echo; done
```

## Unmount early

If the user wants a mount removed before its TTL:

```bash
NAME="repo-name"
if [ -L "mounts/$NAME" ]; then unlink "mounts/$NAME"; else rm -rf "mounts/$NAME"; fi
rm -f "mounts/.meta/$NAME.json"
```

## Extend a TTL

Rewrite the sidecar with a new `expiresAt` (re-run the metadata block from the mount step with a new `TTL_HOURS`).

## Pushing changes

`git push` is blocked by default for the containing agints repo. It **is** allowed inside a mount — use `cd mounts/<name> && git push` or `git -C mounts/<name> push`. Only push when the user explicitly asks.

## Notes

- Mounts are under `workspace/buri/mounts/` — the whole workspace is gitignored by agints, so nothing leaks into the agints repo.
- Nested git repos are fine: git walks up from cwd to find the nearest `.git/`, so git commands run inside a mount operate on that mount, not agints.
- Default TTL is 24h. Use longer only when the user explicitly wants to keep a repo around.
