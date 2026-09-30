---
name: repo-mount
description: Mount a local or remote git repo into the workspace temporarily so you can read, grep, explore, and contribute changes back as a pull request. Mounts expire and are swept automatically. Use when the user asks you to look at a repo, clone a repo, add access to a codebase, or fix something in one — including this harness itself.
---

## Repo Mounts

You have a `mounts/` directory in your workspace for temporary access to git repos — either existing local clones on the user's machine or remote URLs that get cloned in. Mounts have an expiry (default 24h) and a SessionStart hook sweeps expired ones at the start of every run.

**Mount layout:**
- `mounts/<name>/` — the repo itself (symlink for local, directory for clones)
- `mounts/.meta/<name>.json` — sidecar with `name`, `kind`, `source`, `mountedAt`, `expiresAt`

**Choose a short, kebab-case `<name>`** — the directory name the user will see when you reference paths. Usually derived from the repo name (e.g. `ignis`, `northstar-legacy`).

## Mount a local repo (symlink)

When the user points you at a path on their machine. **Exception:** to work on
the ignis repo itself, clone it instead — see **Working on ignis itself**.

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

## Contributing changes

`git push` is blocked for the containing ignis repo. It **is** allowed inside a
mount — `cd mounts/<name> && git push` or `git -C mounts/<name> push`.

**Default to a pull request.** Push directly to the default branch only when the
user explicitly asks you to.

```bash
cd mounts/<name>
git checkout -b <short-kebab-branch>
git add <specific paths>            # not -A, see below
git commit -m "<what changed and why>"
git push -u origin <short-kebab-branch>
gh pr create --title "<title>" --body "<what, why, how you verified it>"
```

- **Stage specific paths.** `git add -A` sweeps up unrelated work already in the
  tree — build artifacts, someone's half-finished edit — and puts it in the PR.
- **Say in the PR body that you opened it**, and what prompted it (a ticket, a
  request). `gh` is authenticated as the team member who owns this machine, so
  the PR is authored under *their* GitHub account: a reviewer has no other way
  to tell a human didn't write it.
- **Say how you verified it** — the tests you ran and their result, or plainly
  that you couldn't verify. A PR nobody can check is work for the reviewer, not
  work saved.
- Never force-push, never push to a branch you didn't create, never merge your
  own PR. Review is the point.

## Working on ignis itself

This repo is the harness you run on, so two extra rules apply.

**Clone it — never symlink it.** The local-mount recipe above makes a symlink,
which would point at the *live working tree*: your edits would hit the running
install and your `git add` could stage the team's uncommitted work. Clone
instead, even though the source is a local path — that gives you an isolated
checkout at HEAD:

```bash
git clone /path/to/ignis mounts/ignis
```

**Never change what governs you.** These files decide what you are allowed to
do, and most of them are read live rather than compiled — `permissions.json`,
`persona.md`, `agent.json`, `jobs/` and `config/` are re-read on every run,
skills take effect on the next one, and `.claude/settings.json` and `scripts/`
take effect on the very next tool call, inside the run that changed them. So a
change here is not a proposal for a human to review later; it is already in
force.

| Do not touch | Why |
|---|---|
| `harness/permissions.json` | the trust-tier policy — what each tier may do |
| `harness/agents/*/agent.json` | which capabilities an agent is granted |
| `harness/agents/*/persona.md` | your own instructions |
| `harness/.claude/settings.json`, `harness/scripts/` | the hooks that enforce all of the above |

If a fix genuinely seems to need one of these, **stop and say so** — in your
reply, or in the ticket. Proposing it to a person is the whole job; making the
change yourself is not.

Everything else — `portal/`, `harness/src/`, docs, tests — is fair game.
Changes to compiled TypeScript (`harness/src/`, `portal/`) need a rebuild and
a restart before they take effect, so they cannot break the running install
mid-PR.

**Tickets don't travel.** Ticket bodies are gitignored, so a fresh clone's
`harness/agents/<agent>/tickets/` holds only its README. Read the ticket from
your own `tickets/` (the live one in your workspace) and carry what you need
into the checkout — don't assume the clone has it.

## Notes

- Mounts are under `mounts/` in your workspace, which lives outside the ignis repo, so nothing leaks into it.
- Nested git repos are fine: git walks up from cwd to find the nearest `.git/`, so git commands run inside a mount operate on that mount, not ignis.
- Default TTL is 24h. Use longer only when the user explicitly wants to keep a repo around.
