# Buri Agent Portal

Control plane for the Buri agent system. Built with Next.js.

## Roles

- **Control API** (`/api/control`) -- triggers agent executions, sends outbound notifications, manages scheduling
- **Control Plane UI** -- dashboard for agents, conversations, config editing, settings

See [BACKEND.md](../docs/BACKEND.md) for the API server's client classes and endpoint groups.

## Running

```bash
pnpm dev                  # dev server with hot reload (active development only)
pnpm build && pnpm start  # production server — use for long-lived sessions
```

Prefer the production server (`pnpm build && pnpm start`) for anything left
running for hours: the Turbopack dev compiler accumulates memory over long
uptime and will eventually OOM. From the repo root, `make run` (production) and
`make dev` (dev server) wrap these, and `make debug` adds memory diagnostics.
The dev server still needs the harness built (`@agints/harness`) — the `make`
targets handle that for you.

## Ingress

### Control Plane UI

Open `http://localhost:3000`. The agent page shows conversations, config editing, and quick-run buttons for each profile.

### Slack

Connects via Socket Mode (outbound WebSocket -- no public URL or tunnel needed). New threads are classified and routed to the appropriate agent. Replies in the same thread continue the conversation with session resumption.

Setup: Enable Socket Mode in your Slack app settings, generate an App-Level Token (`xapp-...`), subscribe to `message.im` and `app_mention` events. Connection starts automatically when the server boots.

### Control API

The control-plane command surface for agent executions, notifications, and scheduling. Called by the portal UI and by the agent's own tools/skills — **not** by external senders (inbound channel traffic arrives at the `/api/*/webhook` routes instead). See [BACKEND.md](../docs/BACKEND.md) for the client classes.

```bash
# Run an agent (default profile)
curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri"}'

# Run with a specific profile
curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri","profile":"writer","prompt":"Draft a summary"}'

# Send to Slack
curl -X POST localhost:3000/api/control -d '{
  "action": "notify", "channel": "slack",
  "message": "Found 3 vulnerabilities", "from": "sandcastle"
}'

# Schedule for later (works with both notify and run)
curl -X POST localhost:3000/api/control -d '{
  "action": "run", "agentId": "buri", "profile": "xmanager",
  "scheduledFor": "2026-03-28T09:00:00Z"
}'

# Create a recurring schedule
curl -X POST localhost:3000/api/control -d '{
  "action": "schedule", "agentId": "buri", "profile": "xmanager",
  "cron": "0,30 * * * *", "description": "Feed scan every 30 min"
}'

# Check pending scheduled jobs
curl localhost:3000/api/control
```

| Field | Actions | Description |
|-------|---------|-------------|
| `action` | all | `notify`, `run`, or `schedule` |
| `channel` | notify | `slack` (default) |
| `message` | notify | Text to send |
| `from` | notify | Sender attribution, shown as `*[name]* message` |
| `slackChannel` | notify | Explicit channel ID (falls back to default in Settings) |
| `threadTs` | notify | Reply in existing Slack thread |
| `agentId` | run, schedule | Which agent to execute |
| `profile` | run, schedule | Agent profile to activate |
| `prompt` | run, schedule | Prompt for the agent |
| `context` | run | Template variables as key-value map |
| `scheduledFor` | run, notify | ISO timestamp to defer execution |
| `cron` | schedule | Cron expression for recurring jobs |
| `jobId` | schedule | Job ID (for deletion when sent without `cron`/`agentId`) |
| `description` | run, schedule | Human-readable label for scheduled jobs |

## Data Storage

- **Postgres** -- conversations (JSONB messages, session IDs), app settings. Schema auto-creates. Configured via `POSTGRES_URL`.
- **Redis** -- job scheduling (one-shot and recurring), active run locking. Configured via `REDIS_URL`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_URL` | yes | Postgres connection string |
| `REDIS_URL` | yes | Redis connection string |
| `SLACK_BOT_TOKEN` | for Slack | Bot token for sending messages (xoxb-...) |
| `SLACK_APP_TOKEN` | for Slack | App-level token for Socket Mode (xapp-...) |
| `OPENROUTER_API_KEY` | for Slack routing | Powers the agent classifier |
| `LANGFUSE_SECRET_KEY` | for tracing | Langfuse secret key |
| `LANGFUSE_PUBLIC_KEY` | for tracing | Langfuse public key |
| `LANGFUSE_BASE_URL` | for tracing | Defaults to `https://us.cloud.langfuse.com` |
