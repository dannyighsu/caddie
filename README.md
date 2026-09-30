# Ignis

Agents that run the business. Each agent is a declarative config (JSON + persona prompt + optional skills) that the Agent Harness executes via an underlying runtime (currently Claude Code CLI).

## Repository Structure

```
ignis/
├── harness/              # Agent Harness library (@ignis/harness)
│   ├── src/              # Runtime, launcher, capability + resolver system
│   ├── agents/           # Agent definitions (agent.json + persona.md + skills)
│   ├── skills/core/      # Shared skills, mounted for every agent
│   ├── capabilities/     # MCP server configs (JSON files)
│   ├── credentials/      # OAuth tokens (gitignored)
│   ├── resolvers/        # Pre-run data fetchers (e.g., Google Calendar)
│   └── scripts/run.ts    # CLI smoke test
├── portal/               # Control plane + API server (Next.js)
```

## Quick Start

First-time setup, in order. Steps 1–4 get an agent running; 5 connects it to the
outside world.

**1. Install what the runtime needs**

- **Node.js** and **pnpm** 10.22+
- **`claude` CLI** on PATH — the Claude Code CLI is the runtime driver
- **Bun** — only for the `notion` and `web-search` capabilities, which launch
  their MCP servers with `bunx`. Skip it and those two sit out; nothing breaks.
- **Postgres** and **Redis** — an empty database is enough. The schema is
  created on first use; there is no migration step.

```bash
pnpm install
make agent-tools   # poppler + a Python venv with pypdf, so the agent can read PDFs
```

The agent runs directly on this machine, so the command-line tools it reaches
for from Bash have to be installed here — `make agent-tools` covers them.

**2. Configure**

```bash
cp portal/.env.example portal/.env.local
```

Fill in the `REQUIRED` block — that's `POSTGRES_URL`, `REDIS_URL`, one team
member, and Google credentials. The template splits everything else into
variables that already have working defaults and optional per-feature blocks
(Slack, Telegram, Notion, tracing), so the required set is short.

The **team roster** is what makes the agent usable: an inbound sender who isn't
on it is treated as a guest, and guests are granted nothing. At minimum:

```bash
TEAM_MEMBER_A_NAME=Your Name
TEAM_MEMBER_A_EMAIL=you@example.com
```

**3. Authorize Google** (Calendar + Gmail — the agent's inbox and calendar)

In Google Cloud: enable the Calendar and Gmail APIs, then create an OAuth 2.0
**Desktop app** credential with `http://localhost:3456/oauth2callback` as an
authorized redirect URI. Put the client id and secret in `.env.local`, then:

```bash
make google-auth      # opens a browser; writes harness/credentials/ (gitignored)
```

Run it once per install. Skip this only if you want a portal-only agent with no
email and no calendar.

*Optional: Google Sheets, Docs & Slides* (the agent's `google-workspace` skill).
Enable the Sheets, Docs, Slides and Drive APIs in the same Google Cloud project,
install the
[`gog`](https://github.com/openclaw/gogcli) CLI, and authorize the agent's
Google account. This reuses the OAuth client above:

```bash
brew install openclaw/tap/gogcli
make gog-auth ACCOUNT=agent@example.com   # opens a browser; token goes in the OS keyring
```

Then set `GOG_ACCOUNT` to the same address in `.env.local`.

**4. Check it runs**

```bash
make smoke            # launches the agent directly through the harness
```

This needs no server, no Postgres, and no Redis — it verifies the `claude` CLI,
the agent config, and your capability credentials. Anything unconfigured is
reported as skipped rather than failing the run, so read the output: a
capability you expected to see missing means a variable didn't land.

```bash
make run              # portal on http://localhost:3000
```

Open the portal and talk to the agent from the **Conversations** tab.

> `make run` serves a production build — use it for anything long-lived. For
> active development with hot reload, `make dev`.

**5. Connect channels** (each optional, each independent)

Email arrives once step 3 is done. For the rest, see
[TELEGRAM.md](docs/TELEGRAM.md) and the Slack section in
[portal/README.md](portal/README.md); both are just env vars plus setup on
the provider's side. To reach the agent from outside your machine, see
[Network exposure](#network-exposure).

### Making it yours

A fresh clone ships the `buri` agent. To adapt it, edit these — all of it is
also editable in the portal's **Config** tab:

| What | Where |
|---|---|
| Voice, boundaries, how it represents you | `harness/agents/buri/persona.md` |
| Shared standing instructions | `harness/agents/buri/config/preferences.md` |
| Per-person profiles | `harness/agents/buri/config/team/<member>.md` |
| Recurring job procedures | `harness/agents/buri/jobs/` (gitignored — see its README) |

Changes take effect on the agent's next run. Nothing to rebuild or restart.

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

All profiles share the same workspace at `~/.ignis/buri/`.

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

The agent auto-appears in the portal dashboard.

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

`${ENV_VAR}` references are resolved from `process.env` at runtime. A capability with an unresolved reference is **skipped** — not mounted with a blank value — so a missing credential costs you that capability rather than giving the agent a tool that fails at first use. The run proceeds, and the launcher logs which variable was missing. `HARNESS_ROOT` is supplied by the launcher, not read from the environment.

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

Generated from `harness/capabilities/`. Which of these a run actually gets is
*agent's declared capabilities ∩ trust-tier grants ∩ configured credentials* —
see [PERMISSIONS.md](docs/PERMISSIONS.md).

| Name | Needs | Description |
|------|-------|-------------|
| `reply` | — | Reply into the conversation the run is handling. Destination injected by the harness, never chosen by the agent |
| `email-team` | — | Email team members and only them; recipients resolved from the roster. Granted at guest tier too |
| `introspect` | — | Read the agent's own run transcripts for self-diagnosis. Read-only, self-scoped |
| `egress` | — | Outbound messaging and scheduling via the control API |
| `browser` | — | Headed Playwright browser; persistent profile keeps logins |
| `chrome` | — | Flag-only: enables Chrome automation on the runtime |
| `web-search` | Bun | Web search and fetching |
| `email` | Google | Send ad-hoc outbound email; records the thread so replies come back with context |
| `google-calendar` | Google | Calendar read/write |
| `google-gmail` | Google | Gmail search and read, plus attachment download — the agent's inbox |
| `notion` | `NOTION_INTERNAL_TOKEN` | Notion workspace access |

There is also a `google-calendar` **resolver** (`harness/resolvers/`), which is a
different thing: it pre-fetches events into `{{calendarEvents}}` before the run
starts, rather than giving the agent a tool.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Portal (Next.js)                                   │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐ │
│  │ Dashboard │  │ Control   │  │ Postgres + Redis │ │
│  │ (React)   │  │ API       │  │                  │ │
│  └──────────┘  └─────┬─────┘  └──────────────────┘ │
│                       │                              │
│  Slack Socket Mode    │  Scheduler                   │
│  (inbound messages)   │  (Redis-backed, cron)        │
└───────────────────────┼──────────────────────────────┘
                        │ imports @ignis/harness
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

The **portal** imports the harness as a workspace dependency. The control API (`/api/control`) is the command surface for running agents, sending notifications, and managing schedules. Agents with orchestration logic have dedicated orchestrators that handle Slack posting, scheduling, and multi-step execution. See [docs/BACKEND.md](docs/BACKEND.md) for the API server's client classes and endpoint groups.

### Execution flow

1. The control API receives a request (action + agent ID + optional profile)
2. If agent/profile has an orchestrator, it handles the full lifecycle (run lock, launch, Slack, scheduling)
3. Launcher loads `agent.json`, applies profile overrides, symlinks skills/hooks, runs resolvers, interpolates persona, resolves capabilities
4. Runtime spawns `claude` CLI with the prompt + MCP configs
5. Result (text + session ID + usage) is returned and persisted

Session IDs enable multi-turn conversations. On resumption, resolvers and persona are skipped (the runtime has prior context).

## Workspace

Agent workspaces live at `~/.ignis/{agentId}/` by default (override with `WORKSPACE_ROOT`) — outside the repo, since a workspace is the agent's data, not app code. All profiles of an agent share the same workspace. Each agent gets its own directory containing:

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
make build        # build harness + portal
make install      # install all dependencies
make agent-tools  # host tools the agent uses (poppler, pypdf venv)
make smoke        # run a quick smoke test via the harness
make google-auth  # one-time Google Calendar + Gmail OAuth (opens browser, port 3456)
make gog-auth ACCOUNT=...  # one-time Google Sheets/Docs/Slides auth for the gog CLI (opens browser)
```

`make run` vs `make dev`: the dev server runs the Turbopack dev compiler, which
accumulates compiled-module state in memory over long uptime — fine for an
editing session, but it will eventually OOM if left running for hours. The
long-lived control plane should always use `make run` (production build), whose
memory stays flat. Reach for `make dev` only when you want hot reload while
editing.

Or directly:

```bash
cd portal && pnpm dev                                      # dev server (hot reload)
cd portal && pnpm build && pnpm start                      # production server
cd harness && pnpm smoke                                      # default: buri agent
cd harness && pnpm smoke -- --agent buri --prompt "..."       # specify agent and prompt
```

### Debugging memory

`make debug` runs the dev server with Node memory diagnostics from
`portal/scripts/mem-logger.cjs`: periodic per-process `memoryUsage()` logging
(tagged `server` / `agent` / `child`), major-GC logging, and heap-snapshot dumps
(automatic near the heap limit, or on demand via `make debug-snapshot`). Filter
the noise with `make debug 2>&1 | grep ' server '`. Snapshots land in
`portal/` (`*.heapsnapshot`, gitignored) — open them in Chrome DevTools →
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
`TAILNET_PORT`, `IGNIS_PORT`. Verify the live config with
`tailscale serve status`.

> To add a public endpoint, append its path to `FUNNEL_PATHS` in the `Makefile` —
> that list is the entire public attack surface, so keep it minimal. The Next.js
> middleware (`portal/middleware.ts`) keeps a coarse host-based allow-list as a
> secondary backstop, but Tailscale is now the primary gate.

## Configuration reference

Every variable lives in one place: **`portal/.env.example`**, annotated and
split into required / defaulted / optional. Copy it to `portal/.env.local`.

A capability whose variables aren't set is **not mounted** — the run proceeds
without it and the launcher logs which variable was missing. So a missing
credential costs you that one capability; it never fails a run, and it never
gives the agent tools that fail at first use.

Per-integration setup lives with each integration:
[EMAIL.md](docs/EMAIL.md), [TELEGRAM.md](docs/TELEGRAM.md),
[PERMISSIONS.md](docs/PERMISSIONS.md).
