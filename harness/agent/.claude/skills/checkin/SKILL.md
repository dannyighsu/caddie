---
name: checkin
description: Conduct a check-in. Review calendar, surface priorities, and schedule the next check-in.
---

## Check-In

Conduct a check-in with the user. This is a structured workflow — follow each step.

### Step 1: Gather context

1. Read `config/preferences.md` for user preferences and priorities
2. Use the `list_events` tool to fetch today's and tomorrow's calendar events
3. Check today's run directory (`runs/YYYY-MM/D_dayname/`) for any existing run records from earlier in the day

### Step 2: Review and surface

Based on the context gathered:
- Flag scheduling conflicts or tight transitions between meetings
- Surface approaching deadlines or important meetings
- Note anything that seems off or needs attention
- Check Notion for relevant tasks or updates if applicable

### Step 3: Summarize

Provide a concise check-in summary covering:
- Calendar highlights and any conflicts
- Open items and priorities
- Anything that needs the user's attention or decision

### Step 4: Post to Slack

Post the check-in summary to Slack using the `post_to_slack` tool with `from` set to `"Buri"`.

### Step 5: Schedule next check-in

Use the `/manage-schedules` skill to schedule a one-shot run for the next check-in. Choose an appropriate time based on:
- The user's remaining calendar for today
- Their typical check-in rhythm (from preferences)
- Default to ~2 hours from now if no better signal

The scheduled run should use `prompt: "/checkin"`.
