---
name: manage-schedules
description: Create, list, and delete scheduled jobs. Use when the user asks to schedule, set up recurring runs, or manage cron jobs. ALWAYS use this skill instead of Claude Code's built-in /cron or CronCreate tools.
---

## Schedule Management

Use the **egress MCP scheduling tools** to create and manage scheduled jobs. These are native tools that you call with structured arguments — do NOT write curl commands.

**CRITICAL:** Do NOT use Claude Code's built-in cron/scheduling tools (`CronCreate`, `CronList`, `CronUpdate`, `CronDelete`, `RemoteTrigger`, etc.). They are blocked at the hook level and will be denied. Always use the tools below instead.

## Available Tools

| Tool | When to use |
|---|---|
| `schedule_reminder` | User wants a one-time reminder/notification at a specific time ("remind me at 3pm", "ping me tomorrow") |
| `schedule_recurring` | User wants something to run on a recurring schedule ("every weekday at 9am", "every 30 minutes") — an agent run **or** a plain shell command, see below |
| `schedule_oneshot_run` | User wants the agent to actually do work at a future time (not just send a reminder) |
| `list_schedules` | User asks "what's scheduled?" or you need to find a job ID |
| `update_schedule` | User asks to change something about an existing schedule (cron, prompt, description, notification channel) |
| `delete_schedule` | User asks to cancel a scheduled job |

### Choosing between `schedule_reminder` and `schedule_oneshot_run`

- **`schedule_reminder`** — fire-and-forget notification. Use this for "remind me to call mom at 8pm". The system just sends the message at the specified time. **Most reminder requests should use this.**
- **`schedule_oneshot_run`** — launches a full agent run at a future time. Use this only when the user wants the agent to actually do work (e.g., "at 5pm, run the metrics check and tell me what you find").

When in doubt for a reminder request, use `schedule_reminder`.

## Agent runs vs. command jobs (`schedule_recurring`)

A recurring job is one of two kinds, picked with `type`:

- **`type: "agent"` (the default)** — every tick is a full agent turn driven by
  `prompt`. Right when the work itself needs judgment each time: a morning
  brief, a weekly digest, a check-in.
- **`type: "command"`** — every tick runs one shell `command`, and a tick that
  prints **nothing** ends there. Right for **polling**, where most ticks have
  nothing to report.

### Why the distinction matters

A 5-minute poll written as an agent run is roughly 130 agent turns a workday to
surface a handful of events. The same poll as a command job is 130 cheap
subprocesses, and an agent turn only on the ticks that actually found something.
**If a job's first step is "check whether anything changed", it wants to be a
command job.** Don't reach for a coarser interval to control the cost of an
agent-run poller — use a command job and keep the interval you actually want.

### What happens to the output

`onOutput` decides what a tick that *did* print something does:

| `onOutput` | Effect |
|---|---|
| `"run"` (default) | Launch an agent run, with the command's stdout appended to `prompt`. The run starts with the lines that woke it already in context. |
| `"notify"` | Send the stdout to the job's notification channel. Good for a check whose output is already the message. |
| `"ignore"` | Log it only. Plain maintenance cron (a sync, a cleanup). |

Empty stdout **always** means do nothing — no run, no notification. A non-zero
exit, or a command that overruns `commandTimeoutMs`, is reported as a job
failure on the notification channel like any other, regardless of what it
printed.

### Writing the command

- `command` is a **full command line** run through a shell, so `&&`, pipes and
  redirection work: `git pull -q && python3 scripts/poll.py`.
- `cwd` is **workspace-relative** and must stay inside the workspace. A path
  outside it is rejected.
- The command gets a **minimal environment** — `PATH`, `HOME`, `LANG`, `TZ` and
  nothing else. If it needs a token, name it in `commandEnv`
  (`commandEnv: ["GRANOLA_API_KEY"]`) — pass the **name**, never the value. A
  name that isn't set in the environment is simply not forwarded, so check that
  the secret exists before relying on it.
- `commandTimeoutMs` defaults to 60s and caps at 10 minutes. The command and
  anything it spawned are killed on overrun.
- **Repo mounts expire.** A command job pointed at `mounts/<repo>` will start
  failing once that mount is swept. Say so when a job's design depends on a
  checkout, rather than scheduling something that quietly breaks in a day.

### Example

A 5-minute poll that wakes the agent only when the script prints something:

```
schedule_recurring(
  cron: "*/5 8-19 * * 1-5",
  type: "command",
  command: "git pull -q && python3 scripts/poll-followups.py",
  cwd: "mounts/library",
  onOutput: "run",
  prompt: "/granola-followup",
  commandEnv: ["GRANOLA_API_KEY"],
  description: "Poll for ended calls needing a follow-up draft"
)
```

Test it before trusting it: `list_schedules` to get the job id, then run it once
from the portal's Runs view (or re-check on the next tick) and confirm a quiet
tick stays quiet.

## Time handling

The user often gives times in natural language ("at 8pm", "tomorrow morning", "in 30 minutes"). Convert these to ISO 8601 timestamps with the user's timezone offset (typically `-07:00` for PDT or `-08:00` for PST). The current time and timezone are provided in your run context — use them to compute absolute times.

Examples:
- "at 8pm" today → `2026-04-09T20:00:00-07:00` (using current date and PDT offset)
- "tomorrow at 9am" → next day at 09:00 in user's timezone
- "in 30 minutes" → current time + 30 minutes, formatted as ISO

**Always include the timezone offset.** Never send a bare local time.

## Notification channel

When the user doesn't specify a channel, set `notificationChannel` to match the **`originChannel`** in your run context — reach them back on the channel they contacted you on (someone who emailed you gets reminded by email). Override only when they explicitly ask for a different channel (e.g., "remind me on Telegram", "email me the result").

## Cron expressions (for `schedule_recurring`)

Cron format: `minute hour day-of-month month day-of-week`

Examples:
- `0 9-20 * * 1-5` — every hour 9AM-8PM weekdays
- `0 9,12,15,18,21 * * 0,6` — every 3 hours 9AM-9PM weekends
- `0,30 * * * *` — every 30 minutes
- `*/5 * * * *` — every 5 minutes (steps work; pair a tight interval like this
  with `type: "command"` so a quiet tick doesn't cost an agent run)
- `0 9 * * 2` — Tuesdays at 9AM
- `0 9 * * *` — every day at 9AM
