# agints

Agents that run the business. Each agent is a declarative config (JSON + persona prompt + optional skills) that the Agent Harness executes via an underlying runtime (currently Claude Code CLI).

## Repository Structure

```
agints/
├── harness/              # Agent Harness library (@agints/harness)
│   ├── src/              # Runtime, launcher, capability + resolver system
│   ├── agents/           # Agent definitions (agent.json + persona.md + skills)
│   ├── capabilities/     # MCP server configs (JSON files)
│   ├── resolvers/        # Pre-run data fetchers (e.g., Google Calendar)
│   └── scripts/run.ts    # CLI smoke test
├── northstar/            # Control plane + API server (Next.js)
├── workspace/            # Agent working directories (gitignored)
└── sandcastle/           # Security investigation project
```

## Quick Start

```bash
pnpm install              # install dependencies
make run                  # start Northstar (production build) on http://localhost:3000
make smoke                # run a smoke test directly via the harness
```

> Use `make run` for any long-lived session — it serves a production build, so
> memory stays bounded. For active development with hot reload, use `make dev`.

## Creating an Agent

An agent is a directory under `harness/agents/` containing a config and a persona.

### 1. Create the agent directory

```
harness/agents/<id>/
├── agent.json
├── persona.md
└── .claude/skills/       # optional: Claude Code native skills
    └── <skill-name>/
        └── SKILL.md
```

### 2. Define agent.json

```json
{
  "id": "buri",
  "name": "Buri",
  "persona": "./persona.md",
  "capabilities": ["notion"],
  "resolvers": ["google-calendar"],
  "maxTurns": 20,
  "profiles": {
    "writer": {
      "capabilities": ["notion", "web-search"],
      "maxTurns": 30
    },
    "xmanager": {
      "capabilities": ["chrome"]
    }
  }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier, matches the directory name |
| `name` | yes | Human-readable name shown in the dashboard |
| `persona` | yes | Path to persona markdown (relative to agent dir), or inline string |
| `capabilities` | yes | Capability names (references JSON files in `harness/capabilities/`) |
| `resolvers` | no | Pre-run resolver names (references files in `harness/resolvers/`) |
| `maxTurns` | no | Max agent loop iterations. Default: 20 |
| `enableChrome` | no | Enable Chrome browser automation. Can also be set via the `chrome` capability |
| `outputSchema` | no | JSON Schema for structured output. Omit for free-form mode |
| `profiles` | no | Named capability profiles. Each can override `capabilities`, `resolvers`, `maxTurns` |

### Profiles

Profiles are capability sets. They control which MCP servers and resolvers are loaded for a given run. All profiles share the same persona, workspace, config, and skills. Any profile can be used conversationally (Slack, UI) or on a schedule.

```bash
# Run with the writer profile (notion + web-search)
curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri","profile":"writer","prompt":"Draft a post about AI agents"}'

# Run with xmanager profile (chrome — can browse X)
curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri","profile":"xmanager","prompt":"/feed-scan"}'

# Run with no profile (default: notion + google-calendar)
curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri","prompt":"Do a check-in"}'

# Schedule xmanager to run every 30 minutes
curl -X POST localhost:3000/api/control -d '{"action":"schedule","agentId":"buri","profile":"xmanager","cron":"0,30 * * * *","prompt":"/feed-scan"}'
```

All profiles share the same workspace at `workspace/buri/`.

### 3. Write persona.md

The persona is the system prompt. Supports `{{templateVar}}` interpolation -- the caller passes a `context` map and resolvers inject additional variables before launch.

```markdown
# Persona: Buri

You are a skilled assistant helping the user brainstorm,
research, draft, and refine content.

## Current Context
Current time: {{currentTime}}
```

Unresolved `{{variables}}` are left as-is so you can spot missing context.

### 4. Add skills (optional)

Skills use Claude Code's native SKILL.md format in `.claude/skills/`:

```
harness/agents/buri/.claude/skills/feed-scan/SKILL.md
harness/agents/buri/.claude/skills/metrics-check/SKILL.md
```

Skills are symlinked into the agent's workspace automatically. The agent invokes them via `/skill-name` in the prompt.

### 5. Done

The agent auto-appears in the Northstar dashboard.

## Adding a Capability

Capabilities are MCP server configurations. Each is a JSON file in `harness/capabilities/` that agents reference by name.

> A new capability is **denied by default** for every trust tier until you grant it in `harness/permissions.json`. Permissions (which tier gets which capabilities and the built-in tools) live in one place — see [docs/PERMISSIONS.md](docs/PERMISSIONS.md).

### MCP server capability

```json
{
  "name": "notion",
  "description": "Notion workspace access via MCP",
  "server": {
    "command": "npx",
    "args": ["-y", "@notionhq/notion-mcp-server"],
    "env": {
      "NOTION_TOKEN": "${NOTION_INTERNAL_TOKEN}"
    }
  }
}
```

`${ENV_VAR}` references are resolved from `process.env` at runtime. Missing env vars produce warnings, not errors.

### Flag-only capability

Omit the `server` field for capabilities that just enable a runtime flag:

```json
{
  "name": "chrome",
  "description": "Chrome browser automation (enables --chrome flag)"
}
```

### Adding a Resolver

Resolvers fetch data deterministically before each agent run and inject results as template variables. Define in `harness/resolvers/`:

```json
{
  "name": "google-calendar",
  "description": "Fetches today's calendar events as {{calendarEvents}}",
  "module": "./google-calendar.ts",
  "requiredEnv": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]
}
```

Reference in agent.json: `"resolvers": ["google-calendar"]`

### Current capabilities

| Name | Type | Description |
|------|------|-------------|
| `notion` | MCP server | Notion workspace access |
| `web-search` | MCP server | Web fetching |
| `chrome` | Flag | Chrome browser automation |
| `google-calendar` | Resolver | Injects `{{calendarEvents}}` from Google Calendar API |

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Northstar (Next.js)                                │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ Dashboard │  │ Control   │  │ Postgres + Redis │ │
│  │ (React)   │  │ API       │  │                  │ │
│  └──────────┘  └─────┬─────┘  └──────────────────┘ │
│                       │                              │
│  Slack Socket Mode    │  Scheduler                   │
│  (inbound messages)   │  (Redis-backed, cron)        │
└───────────────────────┼──────────────────────────────┘
                        │ imports @agints/harness
┌───────────────────────┼──────────────────────────────┐
│  Agent Harness        │                              │
│                       ▼                              │
│  ┌──────────────────────────────┐                    │
│  │ Launcher                     │                    │
│  │ load agent.json + profile    │                    │
│  │ → symlink skills + hooks     │                    │
│  │ → run resolvers              │                    │
│  │ → read + interpolate persona │                    │
│  │ → resolve MCP capabilities   │                    │
│  │ → call runtime.execute()     │                    │
│  └──────────────┬───────────────┘                    │
│                 │                                    │
│  ┌──────────────▼───────────────┐                    │
│  │ AgentRuntime (interface)     │                    │
│  │ ClaudeCodeRuntime            │                    │
│  │ (claude CLI → subprocess)    │                    │
│  └──────────────────────────────┘                    │
└──────────────────────────────────────────────────────┘
```

**Harness** is a pure TypeScript library. Two main functions:

- `createRuntime()` -- instantiates an `AgentRuntime`
- `createLauncher(runtime, config)` -- returns `{ launch }` bound to agent and capability directories

**Northstar** imports the harness as a workspace dependency. The control API (`/api/control`) is the command surface for running agents, sending notifications, and managing schedules. Agents with orchestration logic have dedicated orchestrators that handle Slack posting, scheduling, and multi-step execution. See [docs/BACKEND.md](docs/BACKEND.md) for the API server's client classes and endpoint groups.

### Execution flow

1. The control API receives a request (action + agent ID + optional profile)
2. If agent/profile has an orchestrator, it handles the full lifecycle (run lock, launch, Slack, scheduling)
3. Launcher loads `agent.json`, applies profile overrides, symlinks skills/hooks, runs resolvers, interpolates persona, resolves capabilities
4. Runtime spawns `claude` CLI with the prompt + MCP configs
5. Result (text + session ID + usage) is returned and persisted

Session IDs enable multi-turn conversations. On resumption, resolvers and persona are skipped (the runtime has prior context).

## Workspace

Agent workspaces live at `workspace/{agentId}/` in the repo root by default. All profiles of an agent share the same workspace. Each agent gets its own directory containing:

- `config/` -- persistent config files (editable via the control plane)
- `.claude/` -- symlinked skills and hooks from the agent definition
- Everything else -- created by the agent during runs (task files, memory, run records, etc.)

Override the workspace location with `WORKSPACE_ROOT`:

```bash
make run WORKSPACE_ROOT=/path/to/workspace
```

The workspace directory is gitignored.

## Running

```bash
make run          # PROD: next build + next start on http://localhost:3000 (use for long-lived sessions)
make dev          # DEV: next dev with hot reload (active development only)
make debug        # DEV + memory diagnostics (see below)
make build        # build harness + northstar
make install      # install all dependencies
make smoke        # run a quick smoke test via the harness
make google-auth  # one-time Google Calendar OAuth setup (opens browser)
```

`make run` vs `make dev`: the dev server runs the Turbopack dev compiler, which
accumulates compiled-module state in memory over long uptime — fine for an
editing session, but it will eventually OOM if left running for hours. The
long-lived control plane should always use `make run` (production build), whose
memory stays flat. Reach for `make dev` only when you want hot reload while
editing.

Or directly:

```bash
cd northstar && pnpm dev                                      # dev server (hot reload)
cd northstar && pnpm build && pnpm start                      # production server
cd harness && pnpm smoke                                      # default: buri agent
cd harness && pnpm smoke -- --agent buri --prompt "..."       # specify agent and prompt
```

### Debugging memory

`make debug` runs the dev server with Node memory diagnostics from
`northstar/scripts/mem-logger.cjs`: periodic per-process `memoryUsage()` logging
(tagged `server` / `agent` / `child`), major-GC logging, and heap-snapshot dumps
(automatic near the heap limit, or on demand via `make debug-snapshot`). Filter
the noise with `make debug 2>&1 | grep ' server '`. Snapshots land in
`northstar/` (`*.heapsnapshot`, gitignored) — open them in Chrome DevTools →
Memory.

## Network exposure

`make run` splits the control plane's network surface in two, enforced by
**Tailscale before any request reaches Next**:

| Reachable from | How | What's exposed |
|---|---|---|
| **Public internet** | Tailscale **Funnel** on `:443` | Only the ingress webhooks: `/api/telegram/webhook`, `/api/email/webhook` |
| **Your tailnet + this machine** | Tailscale **Serve** on `:8443` | The full control plane — dashboards, control API, all other endpoints |
| **This machine only** | direct | `http://localhost:3000` |

Third-party services (Telegram, AgentMail) can only reach the two webhook paths.
Every other route — the dashboards, the control API, agent config, settings — is
invisible to the public internet and reachable only from devices on your
Tailscale network (at `https://<node>.<tailnet>.ts.net:8443`) or locally. The
boundary is enforced at the Tailscale proxy, so a public request to any
non-webhook path is rejected before it ever hits the app.

### Why two ports

Tailscale's Funnel (public) switch is **per-port, not per-path** — every mount on
a Funnel-enabled port is public. So the public webhooks get their own port
(`:443`) with nothing else mounted there, and the full app is served to the
tailnet on a separate port (`:8443`).

### Commands

```bash
make run        # build → configure exposure → start the server
make expose     # (re)configure Tailscale serve/funnel only — idempotent
make unexpose   # tear down all serve/funnel config for this node
```

Exposure config persists (via `tailscale ... --bg`) across app restarts until you
run `make unexpose`. It requires the `tailscale` CLI and a tailnet with
[Funnel enabled](https://tailscale.com/kb/1223/funnel); if `tailscale` isn't
installed, `make run` still starts the server localhost-only (webhooks just won't
be reachable from the internet). Tune via make variables `FUNNEL_PATHS`,
`TAILNET_PORT`, `NORTHSTAR_PORT`. Verify the live config with
`tailscale serve status`.

> To add a public endpoint, append its path to `FUNNEL_PATHS` in the `Makefile` —
> that list is the entire public attack surface, so keep it minimal. The Next.js
> middleware (`northstar/middleware.ts`) keeps a coarse host-based allow-list as a
> secondary backstop, but Tailscale is now the primary gate.

## Prerequisites

- **Node.js** and **pnpm** (10.22+)
- **`claude` CLI** on PATH -- the Claude Code CLI is the current runtime driver
- **Postgres** -- `POSTGRES_URL` in `northstar/.env.local`
- **Redis** -- `REDIS_URL` in `northstar/.env.local`
- **Env vars for capabilities** -- e.g., `NOTION_INTERNAL_TOKEN` for Notion. Missing vars produce warnings, not errors.
- **Google Calendar** (optional) -- set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `northstar/.env.local`, then run `make google-auth` once to authorize. Tokens are saved to `harness/credentials/` (gitignored).
- **Telegram** (optional) -- connect your agent to Telegram via the Bot API. See [TELEGRAM.md](docs/TELEGRAM.md) for setup instructions.
- **Email** (optional) -- See [EMAIL.md](docs/EMAIL.md) for setup instructions.
