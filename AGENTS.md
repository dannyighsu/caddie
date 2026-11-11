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

## Reporting the harness's own defects

When an agent hits something that looks like a defect in its own machinery — a
tool that fails like a bug, a capability that isn't mounted, a run that went
wrong for a reason no instruction explains — it does **not** write a file in its
workspace. There is no `tickets/` directory and no `ticketing` skill any more.
Two routes, and the agent picks by whether the fix is in this repo:

| Situation | What the agent does |
|---|---|
| The fix is in its own code (prompt, skill, harness, portal) | Mounts this repo and opens a pull request — `harness/skills/core/repo-mount/SKILL.md` |
| It isn't the agent's to fix, or needs a decision first | Raises it with the team in the reply or by `email_team`, and files it in the team's own tracker if the install has one |

Either way the report has to carry the `sessionId` and the error text, because
traces are evicted after about a week.

### Why the local tickets went away

A ticket in the workspace was invisible to everyone who wasn't reading that
install's disk, had no status and no owner, and — the reason it was dropped —
"create a ticket" is what a team member says when they mean *an issue in our
tracker*. The generic phrase captured the harness-defect skill, so a request
that should have gone to the team's issue tracker silently became a markdown
file nobody would see. A PR is the better artifact anyway: it is reviewable,
revertable, and already the proposal.

### Changing how this works

| What | Where |
|---|---|
| What the agent is told to do with a defect | the Self-diagnosis capability in `harness/agent/SYSTEM.md` |
| What "create a ticket" from a team member means | the Task tracking capability in `harness/agent/SYSTEM.md` |
| How a PR against this repo is made, and what the agent must not change | `harness/skills/core/repo-mount/SKILL.md` |

Behavior changes belong in the **skill**, not the persona — the persona only
points at it. Keep the two in sync when you rename or move anything.

### Conventions worth preserving

- **Never a substitute for answering the person.** A report, a PR and a reply
  are not interchangeable; the reply always ships.
- **Team turns only.** A guest's run never produces a defect report or a PR.
  Reference a `sessionId` rather than quoting private content, so guest-supplied
  text never reaches the repo.
- **A repeat of a known problem joins the existing report** — a comment on the
  issue or the open PR — rather than starting a second one. The occurrence count
  is the signal for how live a bug is, and near-duplicates destroy it.
- **`tickets/` stays in the exclusion lists.** `portal/lib/rag-files.ts` and
  `harness/tools/artifacts-publish.mjs` still exclude and protect the path.
  Installs that ran the old behavior have real files there; keep them out of RAG
  and out of published artifacts rather than re-exposing them.

A defect report is a report about the system, not a to-do list. Standing
preferences go in `config/`, skill changes go through `manage-skills`, and
one-off steering for a recurring job goes in `state/<job>.md`.

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
