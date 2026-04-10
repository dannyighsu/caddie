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
| `schedule_recurring` | User wants something to run on a recurring schedule ("every weekday at 9am", "every 30 minutes") |
| `schedule_oneshot_run` | User wants the agent to actually do work at a future time (not just send a reminder) |
| `list_schedules` | User asks "what's scheduled?" or you need to find a job ID |
| `delete_schedule` | User asks to cancel a scheduled job |

### Choosing between `schedule_reminder` and `schedule_oneshot_run`

- **`schedule_reminder`** — fire-and-forget notification. Use this for "remind me to call mom at 8pm". The system just sends the message at the specified time. **Most reminder requests should use this.**
- **`schedule_oneshot_run`** — launches a full agent run at a future time. Use this only when the user wants the agent to actually do work (e.g., "at 5pm, run the metrics check and tell me what you find").

When in doubt for a reminder request, use `schedule_reminder`.

## Time handling

The user often gives times in natural language ("at 8pm", "tomorrow morning", "in 30 minutes"). Convert these to ISO 8601 timestamps with the user's timezone offset (typically `-07:00` for PDT or `-08:00` for PST). The current time and timezone are provided in your run context — use them to compute absolute times.

Examples:
- "at 8pm" today → `2026-04-09T20:00:00-07:00` (using current date and PDT offset)
- "tomorrow at 9am" → next day at 09:00 in user's timezone
- "in 30 minutes" → current time + 30 minutes, formatted as ISO

**Always include the timezone offset.** Never send a bare local time.

## Notification channel

By default, all reminders and scheduled run results are delivered on **Slack**. The user can override this by explicitly asking (e.g., "remind me on WhatsApp", "email me the result").

When the user does NOT specify a channel, set `notificationChannel` to match the **`originChannel`** from your run context — i.e., reach the user back on the same channel they contacted you on. This ensures someone who emailed you gets reminded by email, not Slack.

Override only when the user explicitly asks for a different channel.

## Cron expressions (for `schedule_recurring`)

Cron format: `minute hour day-of-month month day-of-week`

Examples:
- `0 9-20 * * 1-5` — every hour 9AM-8PM weekdays
- `0 9,12,15,18,21 * * 0,6` — every 3 hours 9AM-9PM weekends
- `0,30 * * * *` — every 30 minutes
- `0 9 * * 2` — Tuesdays at 9AM
- `0 9 * * *` — every day at 9AM
