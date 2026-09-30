# Tickets

Bug reports the agent files about its **own machinery** — one file per problem,
named `YYYY-MM-DD-<short-slug>.md`. Written by the agent through the `ticketing`
core skill; read by whoever is developing the harness.

## Why this exists

When a run misbehaves, the evidence is in a transcript that is evicted after
about a week, and the person who would fix it wasn't watching. A ticket is the
agent's chance to investigate while the trace is still reachable — `list_runs`,
`view_run` — and leave behind something actionable.

## Where they land

`tickets/` is symlinked into the workspace from this directory (the launcher's
`ensureDefinitionSymlink`, the same mechanism behind `jobs/` and
`.claude/skills-src`). The agent writes to `tickets/` in its workspace; the file
appears **here**, in the repo working tree, where you can read and grep it:

```bash
ls harness/agents/buri/tickets/
```

Without the link, a ticket would land in the workspace (`~/.ignis/<agent>/`),
outside the repo — it would never reach the people who fix things.

## Not committed

Everything here except this README is gitignored. A ticket quotes real runs —
session ids, error strings, sometimes the shape of a team member's request — so
it belongs to the install and not the repo. It stays in the working tree, which
is where it's meant to be picked up; it just doesn't travel with a clone.

## Lifecycle

There is no status field. A ticket that exists is open; the file is the state.
A repeat of a known problem is appended under that ticket's `## Occurrences`
rather than filed again, so the occurrence list is the signal for how live a
bug is.

Closing is yours, and it means deleting the file — fix it, then remove it.
Telling the agent it's fixed or no longer wanted works too; it will delete.

## What does not belong here

| Kind of thing | Where it goes |
|---|---|
| A standing preference or durable fact | `config/preferences.md`, `config/team/<member>.md` |
| A change to how a skill works | the skill itself, via `manage-skills` |
| One-off steering for a recurring job | `state/<job>.md` in the workspace |
| A task that just couldn't be completed | a reply to the person, not a file |
