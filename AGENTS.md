<!-- OpenSDD Skills (managed by opensdd — do not edit this section) -->
This project uses OpenSDD spec-driven development. Before implementing, modifying, or verifying any code governed by an OpenSDD spec, you MUST load and follow the sdd-manager skill/instructions first. Check `opensdd.json` and `.opensdd.deps/` to identify spec-governed code.
<!-- /OpenSDD Skills -->

## Agent tickets

Agents file bug reports about **their own machinery** — a tool that fails like a
defect, a capability that isn't mounted, a run that went wrong for a reason no
instruction explains. Each is one markdown file in the agent's definition:

```
harness/agents/<agent>/tickets/YYYY-MM-DD-<slug>.md
```

Read them from the repo — that's the whole point of where they live:

```bash
ls harness/agents/buri/tickets/
```

### How it works

`tickets/` is symlinked from the agent definition into the agent's workspace by
`ensureDefinitionSymlink` in `harness/src/agent/launcher.ts` — the same helper
behind `jobs/` and `.claude/skills-src`. The agent writes to `tickets/` in its
workspace and the file lands in the repo working tree.

That indirection is load-bearing. `workspace/` is scratch and gitignored, so a
ticket written there would be swept away exactly when it mattered. `tickets/` is
also the **first writable** thing linked this way — the others are read-only in
practice — so don't "tidy" the helper into something that assumes read-only.

Ticket bodies are gitignored; the README is kept (`.gitignore`, next to the
matching `jobs/` rules). A ticket quotes real runs — session ids, error strings,
the shape of someone's request — so it belongs to the install, not a clone. It
stays readable locally, which is where it gets picked up.

### Changing how tickets work

| What | Where |
|---|---|
| When to file, the file format, investigation steps, guardrails | `harness/skills/core/ticketing/SKILL.md` |
| The workspace link | `ensureDefinitionSymlink` call in `harness/src/agent/launcher.ts` (+ tests in `launcher.test.ts`) |
| What the agent is told it has | `tickets/` bullet and the Self-diagnosis capability in `harness/agents/<agent>/persona.md` |
| Committed vs. ignored | `harness/agents/*/tickets/*` rules in `.gitignore` |

Behavior changes belong in the **skill**, not the persona — the persona only
points at it. Keep the two in sync when you rename or move anything.

**Adding tickets to a new agent:** create `harness/agents/<agent>/tickets/README.md`.
The symlink helper no-ops when the directory is absent, so without a committed
file the agent silently gets no `tickets/` at all.

### Conventions worth preserving

- Tickets have **no status field** — a ticket that exists is open, and the agent
  **never closes one**. Closing is a human act, and it means deleting the file.
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
