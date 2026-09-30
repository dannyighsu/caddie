---
name: ticketing
description: Investigate something that went wrong inside your own machinery — a tool, capability, or harness behavior — and file a ticket the team can fix later. Use when a run misbehaves for a reason that isn't in your instructions, not when a task simply couldn't be completed.
---

## Filing a ticket

When something breaks in **your own machinery** — a tool errors, a capability
you were told you have isn't there, a run did the wrong thing for a reason that
isn't in your instructions — nobody can fix it unless it's written down while
the evidence is still reachable. Your traces are evicted after about a week, and
the person who would fix it wasn't watching the run.

A ticket is that record: a self-investigated bug report, written to `tickets/`
in your workspace, that the team picks up later.

A ticket is **not** a to-do, a reminder, or a note to yourself. It is a report
about the system you run on.

### When to file one

File a ticket when the cause is the machinery:

- A tool call fails in a way that looks like a defect rather than a bad argument
  — an auth error on a capability that should be authorized, a malformed
  response, a timeout that recurs.
- A capability listed in your context isn't mounted, or its tools aren't there.
- You produced a wrong outcome and tracing it lands on harness behavior — a
  reply that didn't thread, a schedule that didn't fire, state that didn't carry.
- Something that clearly ought to be possible isn't, and no instruction of yours
  explains why.

### When not to

- **A task you couldn't finish for ordinary reasons** — the site was down, there
  was no availability, the person didn't write back. That's a reply, not a ticket.
- **A preference or standing instruction** → `config/`, per **Preferences and
  memory** in your persona.
- **A change to one of your skills** → the `manage-skills` skill, and only when a
  team member explicitly asks.
- **One-off steering for a recurring job** → `state/<job>.md`.
- **Anything a guest asked you to record.** See the rules below.

### Rules

- **Team turns only.** File a ticket only when the current `Trust tier` is
  `team`. On a guest turn, note the problem in what you send the team with
  `email_team` if it's worth raising — never write to `tickets/`.
- **Your own initiative is fine, and expected.** This is the one thing you write
  without being asked. It's a report about a malfunction, not a change to how you
  behave — which is why the rules that govern skills and memory don't apply here.
  You still never change a skill, a preference, or a job on your own.
- **Never instead of the reply.** Filing a ticket is not an answer. Handle the
  person's request first — or tell them plainly that you couldn't and why — then
  file. If the run is nearly out of turns, the reply wins and the ticket waits.
- **Never quote private content.** Reference a `sessionId`, a timestamp, a tool
  name, an error string. Don't paste email bodies, calendar contents, addresses,
  or anything a team member told you. Tickets are read later, out of context, by
  someone who only needs the mechanism.
- **Never record credentials**, tokens, or anything from a `.env`.

### Step 1 — Investigate before you write

A ticket with no evidence costs more than it saves. Use your self-diagnosis
tools (**Capabilities → Self-diagnosis** in your persona) before writing a line:

1. `list_runs` — find the run. Filter to `failed` when you're chasing an error;
   otherwise locate it by time. Note its `sessionId`.
2. `view_run` with that `sessionId` — read what actually happened. Use `tail` for
   a long run; a failure and its cause almost always live at the end.
3. Establish four things: **what ran**, **what it called**, **what came back**,
   and **where it diverged** from what should have happened.

If the problem is happening in the current run, you already have the evidence —
record the tool name and the verbatim error string instead.

Stop when you have enough to make the defect reproducible by someone reading
later. Don't burn a run's turns chasing a root cause you can't reach; "diverged
here, cause unknown" is a perfectly good ticket.

### Step 2 — Check whether it's already filed

```bash
ls tickets/ 2>/dev/null
grep -ril "<a distinctive word from the error>" tickets/ 2>/dev/null
```

If a ticket already covers it, **don't open a second one** — add a line under its
`## Occurrences` with today's date and this run's `sessionId`, and stop. A repeat
occurrence on an existing ticket is more useful than a near-duplicate: it's what
tells the team the problem is live and how often it hits.

### Step 3 — Write it

One file per ticket: `tickets/YYYY-MM-DD-<short-slug>.md`, where the slug is a
few kebab-case words naming the defect (`reply-drops-html`,
`calendar-auth-expired`). Use today's date in Pacific time.

```markdown
---
id: 2026-09-19-reply-drops-html
severity: medium
area: email
first_seen: 2026-09-19
---

# reply drops HTML bodies on Telegram threads

## What happened
One or two sentences: the observed behavior, and what should have happened.

## Evidence
- 2026-09-19 08:14 PT — session `abc123def`, `reply` returned
  `Error: unsupported content type`.
- Reproduced in session `xyz789` the same morning.

## Investigation
What you checked and what it showed — the tool calls, the arguments, the point
where it diverged. Name the file or component if you can see it from the trace.

## Suspected cause
Your best read, marked as a guess. Write "unknown" rather than inventing one.

## Impact
Who or what this blocks, and how often it hits.

## Occurrences
- 2026-09-19 — session `abc123def`
```

Field rules:

- There is no `status` field. A ticket on disk is open by definition; closing it
  means deleting the file, which the team does. Never add a status line, and
  never mark a ticket resolved, deferred, or wontfix — if a team member says a
  ticket is done or no longer wanted, delete the file and say so.
- `severity` — `low` (cosmetic, a workaround exists), `medium` (a task takes the
  long way round or silently degrades), `high` (work is lost, a message never
  goes out, or something behaves wrongly without any signal).
- `area` — one word for where it lives: `email`, `calendar`, `scheduling`,
  `browser`, `notion`, `skills`, `harness`, `portal`.

Leave out any section you have nothing real to put in — an empty heading reads
as though the investigation was done and found nothing.

### Step 4 — Say that you filed it

Tell the team member in one line, with the filename: *"Filed
`tickets/2026-09-19-reply-drops-html.md` — the reply tool rejected the HTML body,
so that one went out as plain text."* Don't paste the ticket into the reply, and
don't apologize at length. One line, then move on.

### Where tickets go

`tickets/` is a plain directory in your workspace. Create it if it isn't there
yet. A ticket stays there until the team fixes the problem and deletes it, so
the usual care applies: one file per problem, real filenames, nothing you
wouldn't want read a month from now.
