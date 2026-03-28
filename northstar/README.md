# Northstar

Control plane and API gateway for the agints agent system. Built with Next.js.

## Roles

- **API Gateway** — triggers agent executions, routes Slack messages, handles scheduling
- **Control Plane UI** — dashboard for agents, conversations, config editing, settings

## Running

```bash
pnpm dev    # http://localhost:3000
```

## Ingress

### Control Plane UI

Open `http://localhost:3000`. Conversational agents (writer, checkin) have a chat UI. Triggered agents (xmanager) have a Run button.

### Slack

Connects via Socket Mode (outbound WebSocket — no public URL or tunnel needed). New threads are classified and routed to the appropriate agent. Replies in the same thread continue the conversation with session resumption.

Setup: Enable Socket Mode in your Slack app settings, generate an App-Level Token (`xapp-...`), subscribe to `message.im` and `app_mention` events. Connection starts automatically when the server boots.

### Gateway API

Single entry point for all agent executions and notifications. Used by the control plane UI, Slack webhook, external scripts, and other Claude Code instances.

```bash
# Send to Slack
curl -X POST localhost:3000/api/gateway -d '{
  "action": "notify", "channel": "slack",
  "message": "Found 3 vulnerabilities", "from": "sandcastle"
}'

# Run an agent (agents with orchestration logic like checkin/xmanager get it automatically)
curl -X POST localhost:3000/api/gateway -d '{"action": "run", "agentId": "xmanager"}'
curl -X POST localhost:3000/api/gateway -d '{"action": "run", "agentId": "writer", "prompt": "Draft a summary"}'

# Schedule for later (works with both actions)
curl -X POST localhost:3000/api/gateway -d '{
  "action": "notify", "channel": "slack",
  "message": "Morning reminder", "scheduledFor": "2026-03-27T09:00:00Z"
}'

# Check pending scheduled tasks
curl localhost:3000/api/gateway
```

| Field | Actions | Description |
|-------|---------|-------------|
| `action` | both | `notify` or `run` |
| `channel` | notify | `slack` (default) |
| `message` | notify | Text to send |
| `from` | notify | Sender attribution, shown as `*[name]* message` |
| `slackChannel` | notify | Explicit channel ID (falls back to default in Settings) |
| `threadTs` | notify | Reply in existing Slack thread |
| `agentId` | run | Which agent to execute |
| `prompt` | run | Prompt for the agent |
| `context` | run | Template variables as key-value map |
| `scheduledFor` | both | ISO timestamp to defer execution |

## Data Storage

- **Postgres** — conversations (JSONB messages, session IDs), app settings. Schema auto-creates. Configured via `POSTGRES_URL`.
- **Redis** — scheduling, active run locking. Configured via `REDIS_URL`.

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
