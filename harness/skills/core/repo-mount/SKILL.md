---
name: repo-mount
description: Mount a git repo (always a fresh clone of its remote main) into the workspace temporarily so you can read, grep, explore, and contribute changes back as a pull request. Mounts expire and are swept automatically. Use when the user asks you to look at a repo, clone a repo, add access to a codebase, or fix something in one — including this harness itself.
---

## Repo Mounts

You have a `mounts/` directory in your workspace for temporary access to git repos. Every mount is a shallow clone of the repo's **remote `main`** — never a local copy. Each remote is mounted at most once, and mounts expire (default 24h).

**Mount layout:**
- `mounts/<name>/` — the cloned repo
- `mounts/.meta/<name>.json` — sidecar with `name`, `kind`, `source`, `mountedAt`, `expiresAt`

## Mount a repo

Always use the script — don't `git clone` or `ln -s` into `mounts/` by hand:

```bash
python3 "$HARNESS_ROOT/scripts/mount-repo.py" <url-or-local-path>
```

It handles the rules for you:

- **A local path is resolved to its `origin` remote** and that is cloned. A
  local tree can be on another branch, behind, or full of someone's
  uncommitted work — you'd read code that isn't what's shipped, and your edits
  would land in their tree. If the path has no `origin`, the script fails:
  tell the user rather than working around it.
- **Mounting a repo that's already mounted reuses it.** A clean mount on `main`
  is reset to the latest `origin/main`; one with work in progress is left
  alone (with `origin/main` fetched, so branch new work from it). Either way
  its expiry is extended. So when you need a repo, just run the script —
  there's no need to check first, and you never end up with two copies.
- **If the remote has no `main`**, the default branch is cloned and the output
  says which — pass that on to the user.

Options: `--ttl HOURS` (default 24; longer only when the user explicitly wants
to keep a repo around) and `--name NAME` (default: the repo name; needed only
if the script says the name is taken). The script prints the mount path —
refer to it by that path.

## List mounts

```bash
for f in mounts/.meta/*.json; do [ -e "$f" ] && cat "$f" && echo; done
```

## Unmount

Mounts are swept at the start of a run once they've expired, except a mount
with uncommitted changes or unpushed commits: that one is kept, and you'll be
told about it at session start. Push the work (or tell the user it's stranded),
then unmount it. To unmount early:

```bash
NAME="repo-name"
rm -rf "mounts/$NAME" "mounts/.meta/$NAME.json"
```

## Contributing changes

`git push` is blocked for the containing caddie repo. It **is** allowed inside a
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

## Working on caddie itself

This repo is the harness you run on, so two extra rules apply.

**Mount it like any other repo.** `$HARNESS_ROOT` is inside the caddie checkout
you run from, so this clones that checkout's remote `main`:

```bash
python3 "$HARNESS_ROOT/scripts/mount-repo.py" "$HARNESS_ROOT"
```

Never work in the local checkout itself: that tree is the *live install*, on
whatever branch and uncommitted state it happens to be in.

**Never change what governs you.** These files decide what you are allowed to
do, and most of them are read live rather than compiled — `permissions.json`,
`SYSTEM.md`, `PERSONA.md`, `agent.json` and `config/` are re-read on every run,
skills take effect on the next one, and `.claude/settings.json` and `scripts/`
take effect on the very next tool call, inside the run that changed them. So a
change here is not a proposal for a human to review later; it is already in
force.

| Do not touch | Why |
|---|---|
| `harness/permissions.json` | the trust-tier policy — what each tier may do |
| `harness/agent/agent.json` | which capabilities you are granted |
| `harness/agent/SYSTEM.md`, `harness/agent/PERSONA.md` | your own instructions |
| `harness/.claude/settings.json`, `harness/scripts/` | the hooks that enforce all of the above |

If a fix genuinely seems to need one of these, **stop and say so** — in your
reply, or in the ticket. Proposing it to a person is the whole job; making the
change yourself is not.

Everything else — `portal/`, `harness/src/`, docs, tests — is fair game.
Changes to compiled TypeScript (`harness/src/`, `portal/`) need a rebuild and
a restart before they take effect, so they cannot break the running install
mid-PR.

**Tickets aren't in the repo.** They live only in your workspace's `tickets/`.
Read the ticket from there and carry what you need into the checkout.

## Notes

- Mounts are under `mounts/` in your workspace, which lives outside the caddie repo, so nothing leaks into it.
- Nested git repos are fine: git walks up from cwd to find the nearest `.git/`, so git commands run inside a mount operate on that mount, not caddie.
