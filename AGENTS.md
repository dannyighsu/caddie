<!-- OpenSDD Skills (managed by opensdd — do not edit this section) -->
This project uses OpenSDD spec-driven development. Before implementing, modifying, or verifying any code governed by an OpenSDD spec, you MUST load and follow the sdd-manager skill/instructions first. Check `opensdd.json` and `.opensdd.deps/` to identify spec-governed code.
<!-- /OpenSDD Skills -->

## Migrations: hard cutover

This is a personal app with a few independent installs. They share only the
repo and nothing pulls automatically, so each one upgrades on its own schedule
and there are no uptime or backward-compatibility requirements. When you rename
or move persisted state (Redis keys, env vars, file layouts, database schema),
stop the server, migrate once on each install, and restart. Don't carry
dual-read/dual-write paths, fallbacks to old names, or compatibility shims. The
old names go away completely.

An install runs exactly one agent, defined in `harness/agent/`; variation
between runs is a profile in its `agent.json`, never a second agent. Don't
reintroduce an agent id.

The agent's workspace lives outside the repo at `~/.caddie/` (override with
`WORKSPACE_DIR`; resolved by `workspaceDir()` in `harness/src/workspace.ts`).
It's the agent's data, not app code. Don't reintroduce repo-relative workspace
paths.

Its system prompt is `harness/agent/PERSONA.md` followed by
`harness/agent/SYSTEM.md`. `SYSTEM.md` is committed and shared by every
install, so it names no person, place or household; who the agent is and whom
it serves goes in `PERSONA.md`, which is untracked. The same split holds for
skills: `harness/skills/core/` is shared and names nobody, and the agent's own
skills in `harness/agent/.claude/skills/` are untracked. The seeds in
`harness/agent/config/` are generic templates. Setting up an install is
[docs/SETUP.md](docs/SETUP.md).

## Agent tickets

Agents file bug reports about **their own machinery** — a tool that fails like a
defect, a capability that isn't mounted, a run that went wrong for a reason no
instruction explains. Each is one markdown file in the agent's workspace:

```
~/.caddie/tickets/YYYY-MM-DD-<slug>.md
```

Check them when you're working on the harness:

```bash
ls ~/.caddie/tickets/
```

### How it works

Tickets are plain files in the workspace, with no link or harness step behind
them. The workspace is outside the repo and never swept, so a ticket persists
there. It never reaches git: a ticket quotes real runs (session ids, error
strings, the shape of someone's request), so it belongs to the install, not a
clone.

### Changing how tickets work

| What | Where |
|---|---|
| When to file, the file format, investigation steps, guardrails | `harness/skills/core/ticketing/SKILL.md` |
| What the agent is told it has | `tickets/` bullet and the Self-diagnosis capability in `harness/agent/SYSTEM.md` |

Behavior changes belong in the **skill**, not the persona — the persona only
points at it. Keep the two in sync when you rename or move anything.

### Conventions worth preserving

- Tickets have **no status field** — a ticket that exists is open, and the agent
  **never closes one on its own**. Whoever implements the fix closes it by
  deleting the file as the last step of that work — don't leave it for someone
  else to clean up.
- A repeat of a known problem is appended under that ticket's `## Occurrences`
  rather than filed again — the occurrence list is the signal for how live a bug
  is, so a flood of near-duplicates destroys it.
- Tickets are team-turn only, and reference `sessionId` instead of quoting
  private content. Both are deliberate: the first keeps guest-supplied text from
  reaching the repo, the second keeps tickets readable a month later.
- Filing never substitutes for answering the person.

A ticket is a report about the system, not a to-do list. Standing preferences go
in `config/`, skill changes go through `manage-skills`, and one-off steering for
a recurring job goes in `state/<job>.md`.

## Evals

`evals/` replays real situations through real agent runs with every side effect
faked. See `evals/README.md`.

```bash
pnpm eval email-inbound            # the agent on inbound external email
```

Run the relevant suite after changing the system prompt or persona, a skill, standing instruction
or the inbound prompt path (`portal/lib/inbound-prompt.ts`, shared with the
eval driver). Cases run on Sonnet by default. That bar is deliberately tighter
than production's Opus, so don't "fix" a failing case by switching models. When
a behavior is corrected, add the case that would have caught it.
