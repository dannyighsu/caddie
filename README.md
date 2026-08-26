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
pnpm install                                   # install dependencies
cp northstar/.env.example northstar/.env.local # then fill in the REQUIRED block
make run                                       # start Northstar on http://localhost:3000
make smoke                                     # run a smoke test directly via the harness
```

`make run` needs Postgres, Redis, and the required variables in
`northstar/.env.local` — see [Prerequisites](#prerequisites).

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
  "capabilities": ["reply", "notion", "browser"],
  "resolvers": ["google-calendar"],
  "profiles": {
    "extended": {
      "maxTurns": 300
    },
    "research": {
      "addCapabilities": ["web-search"],
      "removeCapabilities": ["notion"],
      "skills": ["feed-scan"]
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
| `maxTurns` | no | Max agent loop iterations. Default: 150 |
| `enableChrome` | no | Enable Chrome browser automation. Can also be set via the `chrome` capability |
| `outputSchema` | no | JSON Schema for structured output. Omit for free-form mode |
| `profiles` | no | Named run variants of this same agent — see below |

### Profiles

A profile is a **run variant of one agent**, not a second agent. It keeps the
agent's identity, persona, and workspace, and varies only what the run can reach
and how long it may run.

| Field | Effect |
|-------|--------|
| `addCapabilities` | Capability names added to the agent's base set |
| `removeCapabilities` | Capability names removed from it (applied before adds) |
| `skills` | Skill directory names this run may use. Omit for all of them |
| `resolvers` · `maxTurns` · `enableChrome` | Replace the agent's value |
| `configFiles` | Merged over the agent's |

Capabilities are **adjusted, not replaced**. A profile that replaced the list
could silently drop something every run depends on — `reply` being the
load-bearing case: an inbound run without it executes and then says nothing.
Naming an unknown profile logs a warning and runs the base configuration rather
than failing the run.

Skills are mounted per run: with no `skills` list the workspace links the whole
skills directory (so the agent can also author new skills into it — see the
`manage-skills` skill); with one, it gets a directory of links to just those.

A profile is always an **explicit** choice — passed to the control API, or set on
a scheduled job. Nothing infers one from message text; inbound messages always
run the base configuration.

```bash
# Run with the extended profile (higher turn ceiling, for long research jobs)
curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri","profile":"extended","prompt":"/feed-scan"}'

# Run with no profile (default: notion + google-calendar)
curl -X POST localhost:3000/api/control -d '{"action":"run","agentId":"buri","prompt":"Do a check-in"}'

# Schedule a recurring run every 30 minutes
curl -X POST localhost:3000/api/control -d '{"action":"schedule","agentId":"buri","cron":"0,30 * * * *","prompt":"/feed-scan"}'
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

Skills use Claude Code's native SKILL.md format, and come from two places:

```
harness/skills/core/manage-schedules/SKILL.md      # shared by every agent
harness/agents/buri/.claude/skills/feed-scan/SKILL.md   # this agent's own
```

**Core skills** (`harness/skills/core/`) are instance-agnostic mechanism —
scheduling, skill authoring, repo mounting. They live outside any agent so a fix
lands once instead of being copied into each agent directory, and so a second
install inherits them through `git pull`.

**Agent skills** live with the agent and belong to that install. On a name
collision the agent's wins, so an install can override a core skill locally.

At launch both sources are mounted into the agent's workspace as
`.claude/skills/` — a directory of per-skill symlinks, rebuilt each run. The
agent invokes them via `/skill-name` in the prompt.

The workspace also gets `.claude/skills-src/`, pointing at the agent's own skill
directory. That's where an agent authors a skill: `.claude/skills/` is an
assembled view, so a file created there would live in the scratch workspace and
be swept on the next run.

**Editing skills.** Because the workspace mounts `.claude/skills` by symlink, a
skill file is only ever stored in one place — the agent definition — and an edit
takes effect on the agent's next run with no rebuild or restart. Two ways to make one:

- **In the portal** — *Agents → \<agent\> → Config → Skills* lists every skill's
  `SKILL.md`, edits it in place, and creates or deletes skills (deleting removes
  the whole skill directory).
- **By the agent itself** — an agent with `base-tools` can write its own
  `.claude/skills/`. Whether it *may* is a persona rule, not a runtime one: Buri's
  persona permits skill changes only when a team member explicitly asks on
  that turn, and its `manage-skills` skill holds the format rules. Guest-tier runs
  can't do it at all — `guest` is denied `base-tools`, so it has no Write, Edit,
  or Bash.

A new or renamed skill isn't visible until a fresh run, since skills are indexed
at session start.

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
| **Public internet** | Tailscale **Funnel** on `:443` | Only the ingress webhook: `/api/telegram/webhook` |
| **Your tailnet + this machine** | Tailscale **Serve** on `:8443` | The full control plane — dashboards, control API, all other endpoints |
| **This machine only** | direct | `http://localhost:3000` |

Third-party services (Telegram) can only reach the webhook path.
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

Start by copying the annotated environment template — it lists every variable,
split into the ones you must set, the ones that already have working defaults,
and the optional per-feature blocks (Slack, Telegram, Notion, tracing):

```bash
cp northstar/.env.example northstar/.env.local
```

- **Node.js** and **pnpm** (10.22+)
- **Bun** — the `notion` and `web-search` capabilities launch their MCP servers with `bunx`. Without it, those two are skipped at launch (with a warning); everything else runs.
- **`claude` CLI** on PATH -- the Claude Code CLI is the current runtime driver
- **Postgres** -- `POSTGRES_URL` in `northstar/.env.local`
- **Redis** -- `REDIS_URL` in `northstar/.env.local`
- **Env vars for capabilities** -- e.g., `NOTION_INTERNAL_TOKEN` for Notion. Missing vars produce warnings, not errors.
- **Google Calendar** (optional) -- set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `northstar/.env.local`, then run `make google-auth` once to authorize. Tokens are saved to `harness/credentials/` (gitignored).
- **Telegram** (optional) -- connect your agent to Telegram via the Bot API. See [TELEGRAM.md](docs/TELEGRAM.md) for setup instructions.
- **Email** (optional) -- See [EMAIL.md](docs/EMAIL.md) for setup instructions.
