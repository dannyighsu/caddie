# Caddie Portal

Control plane for the install's agent. Built with Next.js.

## Roles

- **Control API** (`/api/control`) -- triggers agent executions, sends outbound notifications, manages scheduling
- **Control Plane UI** -- dashboard for the agent, conversations, config editing, settings

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
The dev server still needs the harness built (`@caddie/harness`) — the `make`
targets handle that for you.

## Ingress

### Control Plane UI

Open `http://localhost:3000`. The agent page shows conversations, config editing, and quick-run buttons for each profile.

### Slack

Connects via Socket Mode (outbound WebSocket -- no public URL or tunnel needed). New threads start a conversation on the default profile; replies in the same thread continue it with session resumption. In channels and group DMs, the agent answers only when @mentioned, including in thread replies; in 1:1 DMs, it answers every message, no mention needed. A top-level DM starts its own thread. The bot must be a member of a channel or group DM to hear it.

Setup: From the repo root, run `make slack-app` and open the printed link to create the app (rename it in the prefilled manifest if you like). Install it to the workspace and copy the Bot User OAuth Token (`xoxb-...`) into `SLACK_BOT_TOKEN`; the app asks you to choose a channel at install because the manifest includes incoming webhooks. Under Basic Information, generate an App-Level Token (`xapp-...`) with the `connections:write` scope and put it in `SLACK_APP_TOKEN`. Connection starts automatically when the server boots.

The bot scope list lives in [slack-app-manifest.yml](slack-app-manifest.yml). An existing install picks up a new scope only after you add it under OAuth & Permissions and reinstall the app. To answer DMs, an existing install also needs the `message.im` and `message.mpim` bot events under Event Subscriptions, the `im:history` and `mpim:history` scopes, and the Messages tab enabled under App Home and not read-only, then a reinstall.

### Control API

The control-plane command surface for agent executions, notifications, and scheduling. Called by the portal UI and by the agent's own tools/skills — **not** by external senders (inbound channel traffic arrives at the `/api/*/webhook` routes instead). See [BACKEND.md](../docs/BACKEND.md) for the client classes.

```bash
# Run the agent (default profile)
curl -X POST localhost:3000/api/control -d '{"action":"run"}'

# Run with a prompt
curl -X POST localhost:3000/api/control -d '{"action":"run","prompt":"Draft a summary"}'

# Send to Slack
curl -X POST localhost:3000/api/control -d '{
  "action": "notify", "channel": "slack",
  "message": "Nightly digest ready", "from": "Caddie"
}'

# Schedule for later (works with both notify and run)
curl -X POST localhost:3000/api/control -d '{
  "action": "run", "profile": "extended",
  "scheduledFor": "2026-03-28T09:00:00Z"
}'

# Create a recurring schedule
curl -X POST localhost:3000/api/control -d '{
  "action": "schedule",
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
| `profile` | run, schedule | Agent profile to activate |
| `prompt` | run, schedule | Prompt for the agent |
| `context` | run | Template variables as key-value map |
| `scheduledFor` | run, notify | ISO timestamp to defer execution |
| `cron` | schedule | Cron expression for recurring jobs |
| `jobId` | schedule | Job ID (for deletion when sent without `cron`) |
| `description` | run, schedule | Human-readable label for scheduled jobs |

## Data Storage

- **Postgres** -- conversations (JSONB messages, session IDs), app settings. Schema auto-creates. Configured via `POSTGRES_URL`.
- **Redis** -- job scheduling (one-shot and recurring), active run locking. Configured via `REDIS_URL`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POSTGRES_URL` | yes | Postgres connection string |
| `REDIS_URL` | yes | Redis connection string |
| `WORKSPACE_DIR` | no | The agent's working directory. Defaults to `~/.caddie` |
| `AGENT_NAME` | no | What the portal and alerts call the agent. Defaults to `Caddie` |
| `SLACK_BOT_TOKEN` | for Slack | Bot token for sending messages (xoxb-...) |
| `SLACK_APP_TOKEN` | for Slack | App-level token for Socket Mode (xapp-...) |
| `LANGFUSE_SECRET_KEY` | for tracing | Langfuse secret key |
| `LANGFUSE_PUBLIC_KEY` | for tracing | Langfuse public key |
| `LANGFUSE_BASE_URL` | for tracing | Defaults to `https://us.cloud.langfuse.com` |
