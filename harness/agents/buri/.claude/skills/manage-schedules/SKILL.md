---
name: manage-schedules
description: Create, list, and delete scheduled jobs. Use when the user asks to schedule, set up recurring runs, or manage cron jobs. ALWAYS use this skill instead of Claude Code's built-in /cron or CronCreate tools.
---

## Schedule Management

Use the Northstar gateway API at `http://localhost:3000/api/gateway` to manage scheduled jobs. **Only use this when the user explicitly asks you to.**

**IMPORTANT:** Do NOT use Claude Code's built-in cron/scheduling tools (CronCreate, CronList, etc.). Always use the Northstar gateway API below instead — it has no plan limits and persists across restarts.

### List all scheduled jobs

```bash
curl -s http://localhost:3000/api/gateway | python3 -m json.tool
```

### Create a recurring schedule

```bash
curl -s -X POST http://localhost:3000/api/gateway \
  -H "Content-Type: application/json" \
  -d '{
    "action": "schedule",
    "agentId": "buri",
    "profile": "<profile>",
    "cron": "<cron expression>",
    "prompt": "<prompt to run>",
    "description": "<human-readable description>"
  }'
```

Cron format: `minute hour day-of-month month day-of-week`

Examples:
- `0 9-20 * * 1-5` — every hour 9AM-8PM weekdays
- `0 9,12,15,18,21 * * 0,6` — every 3 hours 9AM-9PM weekends
- `0,30 * * * *` — every 30 minutes
- `0 9 * * 2` — Tuesdays at 9AM

### Schedule a one-shot run

```bash
curl -s -X POST http://localhost:3000/api/gateway \
  -H "Content-Type: application/json" \
  -d '{
    "action": "run",
    "agentId": "buri",
    "profile": "<profile>",
    "prompt": "<prompt>",
    "scheduledFor": "2026-03-30T15:00:00Z"
  }'
```

### Delete a job

```bash
curl -s -X POST http://localhost:3000/api/gateway \
  -H "Content-Type: application/json" \
  -d '{"action": "schedule", "jobId": "<job-id>"}'
```

Get the job ID from the list output.
