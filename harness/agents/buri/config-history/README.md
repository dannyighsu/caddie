# Config history

Timestamped snapshots of the agent's `config/` — its durable memory — written by
the harness at the start and end of every run. One file per version:

```
config-history/team/betty.md.2026-09-19T20-12-03.481Z
config-history/preferences.md.2026-09-21T09-04-55.117Z
```

## Why this exists

`~/.ignis/<agent>/config/` holds the **only** copy of everything the agent has
been told to remember. It is unversioned, outside the repo, and written by both the
agent and whoever is at the keyboard, with no locking. An editor or script
saving a stale copy over it wins silently — which is how a standing instruction
about how the agent signs its mail was lost on 2026-09-19, minutes after the
agent had confirmed it was saved.

These snapshots live in the agent **definition**, outside the workspace, so a
write that clobbers the live file cannot reach them. To put something back, copy
the line out of the newest snapshot that still has it.

## How it behaves

- **Append-only.** Nothing here is overwritten or pruned — deletion is the
  failure mode this defends against. Snapshot names are monotonic, so the last
  one by name is the newest, and two snapshots never collide.
- **Only on change.** A file identical to its newest snapshot isn't copied again,
  so a quiet week costs nothing.
- **Both ends of a run.** That is what makes a loss *detectable*, not just
  recoverable: the run-end snapshot records what the agent left behind, so
  anything missing at the next run's start went missing while no run was in
  progress. The launcher logs that, and on a team turn tells the agent which
  lines disappeared so it can ask whether they still stand.
- **Large files are skipped** (>1 MB) — that's data parked in `config/`, not
  memory.

Mechanism: `harness/src/agent/config-journal.ts`, called from
`harness/src/agent/launcher.ts`. Everything here except this README is
gitignored.
