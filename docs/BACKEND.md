# Backend

The portal is a Next.js app serving both the control-plane UI and an HTTP API.
Business logic lives in `portal/lib/` (scheduling, notifications, agent
launching, persistence); the `app/api/*` route handlers are thin wrappers over
it. The scheduler and server-rendered pages call `lib` **directly, in-process** —
they are not HTTP clients.

There is no "gateway" — it's a plain API server with three classes of client.

## Client classes

The three client classes map onto the three network-exposure tiers (see
[Network exposure](../README.md#network-exposure)):

| Client | What it is | Reaches | Network tier |
|---|---|---|---|
| **External services** | Telegram POSTing inbound messages | `/api/telegram/webhook` **only** | **Public** — Tailscale Funnel `:443` |
| **Portal frontend** | the dashboard in a browser (client-side `fetch`) | read/CRUD APIs + the control API | **Tailnet + local** — Serve `:8443` |
| **Agent run** | a run's MCP tools, `bash` (via skills), and lifecycle hooks | the control API + `/api/traces` | **Local** — from inside runs on the box |

> **Slack and email are not inbound HTTP clients.** Slack connects over Socket
> Mode (an *outbound* WebSocket); email is pulled by an in-process Gmail poller
> (`lib/gmail/poller`) rather than pushed to a webhook. Only Telegram POSTs
> inbound to a webhook route.

## Endpoint groups

- **Webhooks** — `/api/telegram/webhook`. Inbound external messages; the *only*
  route exposed to the public internet. Sender identity and trust tier are
  resolved here, at the boundary. (Email inbound is polled from Gmail in-process,
  not a webhook; its identity/trust is resolved in `lib/email` all the same.)
- **Control API** — `/api/control` (plus `/api/agent/run`). The imperative
  command surface: run the agent, send notifications, and create / trigger / update
  / delete scheduled jobs. Called by the portal and by the agent's own
  tools/skills — never by external senders.
- **Dashboard / read** — `/api/agent*`, `/api/conversations*`,
  `/api/transcripts*`, `/api/settings/*`, `/api/health`. CRUD + observability for
  the UI.
- **Tracing** — `/api/traces`. Receives Claude Code hook events emitted from
  inside agent runs.
- **Public** — `/api/public/*`. Password-gated data + auth for the `/public/*`
  dashboards.

## Where the logic lives

Route handlers stay thin; the work is in `lib/`:

| Area | Modules |
|---|---|
| Scheduling + job execution | `scheduler.ts`, `redis.ts` |
| Outbound messaging | `notification-channels.ts`, `slack.ts`, `telegram.ts`, `email.ts` |
| Inbound channels + identity | `messaging.ts`, `*-handler.ts`, `identity.ts` |
| Inbound attachments | `gmail/parts.ts` + `gmail/attachments.ts`, `slack-files.ts` + `slack-attachments.ts`, `mime.ts` (shared) |
| Agent runs | `harness.ts` (launches via `@ignis/harness`) |
| Persistence | `db.ts` (Postgres) |

## Related docs

- [Network exposure](../README.md#network-exposure) — how the tiers are enforced (Tailscale serve/funnel)
- [TELEGRAM.md](./TELEGRAM.md), [EMAIL.md](./EMAIL.md) — channel setup
