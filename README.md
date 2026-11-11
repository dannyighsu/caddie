# Caddie

An agent that runs the business. An install is one machine running one agent: a declarative config (JSON + system prompt + persona + optional skills) that the Agent Harness executes via an underlying runtime (currently Claude Code CLI). Variation between runs is a profile of that agent, never a second agent.

## Repository Structure

```
caddie/
├── harness/              # Agent Harness library (@caddie/harness)
│   ├── src/              # Runtime, launcher, capability + resolver system
│   ├── agent/            # The agent (agent.json + SYSTEM.md + PERSONA.md + skills)
│   ├── skills/core/      # Shared skills, mounted on every run
│   ├── capabilities/     # MCP server configs (JSON files)
│   ├── credentials/      # OAuth tokens (gitignored)
│   ├── resolvers/        # Pre-run data fetchers (e.g., Google Calendar)
│   └── scripts/run.ts    # CLI smoke test
├── portal/               # Control plane + API server (Next.js)
├── artifacts/            # Password-gated artifact hosting on Cloudflare R2 + Workers
```

## Setup

**[docs/SETUP.md](docs/SETUP.md)** sets up an install from a fresh machine, in
order: host tools, Postgres and Redis, configuration and persona, Google,
Tailscale, keeping a laptop awake, channels, and optional workspace search.

Once it is set up:

```bash
make run              # portal on http://localhost:3000, inside tmux
```

> `make run` serves a production build — use it for anything long-lived. For
> active development with hot reload, `make dev`.

### Making it yours

| What | Where | Tracked |
|---|---|---|
| Who the agent is — name, role, whom it serves, voice | `harness/agent/PERSONA.md` | no — copy `PERSONA.example.md` |
| How the agent works, the same for every install | `harness/agent/SYSTEM.md` | yes |
| Shared standing instructions | `~/.caddie/config/preferences.md` | no — workspace |
| Per-person profiles | `~/.caddie/config/team/<member>.md` | no — workspace |
| Recurring job procedures | `~/.caddie/jobs/<job>.md` | no — workspace |
| Skills only this install uses | `harness/agent/.claude/skills/<skill>/` | no |
| Skills every install shares | `harness/skills/core/<skill>/` | yes |
| Steps before every `make run`, such as a skill sync | `harness/agent/pre-run` | no — copy `pre-run.example` |

All of these are also editable in the portal's **Config** tab. Changes take
effect on the agent's next run, with nothing to rebuild or restart.

A rule every install should follow belongs in `SYSTEM.md`; anything naming a
particular person, place or household belongs in `PERSONA.md` or the
workspace. The same goes for skills: a procedure any install could use is a core
skill, and one tied to this install's accounts, people or jobs is the agent's
own. `harness/agent/config/` holds generic seed files, copied into the
workspace only when the workspace doesn't have them yet.

Job procedures live in the workspace, not the repo: a job names real places,
people and match criteria for one install. On a scheduled run the launcher
injects `jobs/<job>.md` as **"Job instructions"**; the agent keeps the job's
carried state and one-off directives in `state/<job>.md` beside it. Writing the
file doesn't schedule anything — cadence is Redis state, set through the control
API (`action: "schedule"`) or by asking the agent (`manage-schedules` skill).

## The agent

```
harness/agent/
├── agent.json
├── SYSTEM.md             # committed: how the agent works
├── PERSONA.md            # per install, untracked: who it is
├── PERSONA.example.md    # the template for PERSONA.md
├── config/               # generic seed files for the workspace's config/
└── .claude/skills/       # per install, untracked: the agent's own skills
    └── <skill-name>/
        └── SKILL.md
```

### agent.json

```json
{
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
| `capabilities` | yes | Capability names (references JSON files in `harness/capabilities/`) |
| `resolvers` | no | Pre-run resolver names (references files in `harness/resolvers/`) |
| `maxTurns` | no | Max agent loop iterations. Default: 150 |
| `enableChrome` | no | Enable Chrome browser automation. Can also be set via the `chrome` capability |
| `outputSchema` | no | JSON Schema for structured output. Omit for free-form mode |
| `configFiles` | no | Workspace files injected into the run context, as `{ name: path }` |
| `profiles` | no | Named run variants — see below |

### Profiles

A profile is a **run variant of the agent**, not a second agent. It keeps the
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
curl -X POST localhost:3000/api/control -d '{"action":"run","profile":"extended","prompt":"/feed-scan"}'

# Run the base configuration
curl -X POST localhost:3000/api/control -d '{"action":"run","prompt":"Do a check-in"}'

# Schedule a recurring run every 30 minutes
curl -X POST localhost:3000/api/control -d '{"action":"schedule","cron":"0,30 * * * *","prompt":"/feed-scan"}'
```

All profiles share the workspace at `~/.caddie/`.

### The system prompt

A run's system prompt is `PERSONA.md` followed by `SYSTEM.md`. Both support
`{{templateVar}}` interpolation — the caller passes a `context` map and
resolvers inject additional variables before launch. Unresolved `{{variables}}`
are left as-is so you can spot missing context.

### Skills

Skills use Claude Code's native SKILL.md format, and come from two places:

```
harness/skills/core/manage-schedules/SKILL.md      # shared by every install
harness/agent/.claude/skills/feed-scan/SKILL.md    # the agent's own
```

**Core skills** (`harness/skills/core/`) are shared by every install —
mechanism like scheduling, skill authoring and repo mounting, and procedures any
install could use, like email correspondence. A second install inherits them
through `git pull`, so they name no person, account or household.

**Agent skills** (`harness/agent/.claude/skills/`) belong to this install and
are not tracked: they are where the agent writes the skills a team member asks
for, and they name this install's accounts and jobs. On a name collision the
agent's wins, so an install can override a core skill locally.

At launch both sources are mounted into the workspace as `.claude/skills/` — a
directory of per-skill symlinks, rebuilt each run. The agent invokes them via
`/skill-name` in the prompt.

The workspace also gets `.claude/skills-src/`, pointing at the agent's own skill
directory. That's where an agent authors a skill: `.claude/skills/` is an
assembled view, so a file created there would live in the scratch workspace and
be swept on the next run.

**Editing skills.** Because the workspace mounts `.claude/skills` by symlink, a
skill file is only ever stored in one place — the agent definition — and an edit
takes effect on the agent's next run with no rebuild or restart. Two ways to make one:

- **In the portal** — *Agent → Config → Skills* lists every skill's `SKILL.md`,
  edits it in place, and creates or deletes skills (deleting removes the whole
  skill directory).
- **By the agent itself** — the agent with `base-tools` can write its own
  `.claude/skills/`. Whether it *may* is a rule in `SYSTEM.md`, not a runtime
  one: skill changes are permitted only when a team member explicitly asks on
  that turn, and the `manage-skills` skill holds the format rules. Guest-tier
  runs can't do it at all — `guest` is denied `base-tools`, so it has no Write,
  Edit, or Bash.

A new or renamed skill isn't visible until a fresh run, since skills are indexed
at session start.

## Adding a Capability

Capabilities are MCP server configurations. Each is a JSON file in `harness/capabilities/` that `agent.json` references by name.

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

`${ENV_VAR}` references are resolved from `process.env` at runtime. A capability with an unresolved reference is **skipped** — not mounted with a blank value — so a missing credential costs you that capability rather than giving the agent a tool that fails at first use. The run proceeds, and the launcher logs which variable was missing. `HARNESS_ROOT` and `CADDIE_WORKSPACE` (the workspace path, for state like a search index) are supplied by the launcher, not read from the environment.

A capability can also list `"disallowedTools"`: tools its server exposes that no run may call, by the server's own tool name. They're removed from the run with `--disallowedTools`. Use it when a third-party server bundles writes alongside the reads you want, as `local-rag` does.

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
| `purge` | — | Remove suspected phishing/prompt injection from history, workspace and search; emails the team. Guest runs can purge only the message being handled |
| `local-rag` | `LOCAL_RAG_ENTRY` | Search past conversations and workspace files (read-only; the portal indexes) |
| `artifacts` | Settings → Artifacts (R2 token) | Publish workspace files as a password-protected link that opens from any device. Team tier only |
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
                        │ imports @caddie/harness
┌───────────────────────┼──────────────────────────────┐
│  Agent Harness        │                              │
│                       ▼                              │
│  ┌──────────────────────────────┐                    │
│  │ Launcher                     │                    │
│  │ load agent.json + profile    │                    │
│  │ → symlink skills + hooks     │                    │
│  │ → run resolvers              │                    │
│  │ → persona + system prompt    │                    │
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

The **portal** imports the harness as a workspace dependency. The control API (`/api/control`) is the command surface for running the agent, sending notifications, and managing schedules. See [docs/BACKEND.md](docs/BACKEND.md) for the API server's client classes and endpoint groups.

### Execution flow

1. The control API receives a request (action + optional profile)
2. Launcher loads `agent.json`, applies profile overrides, symlinks skills/hooks, runs resolvers, interpolates the persona and system prompt, resolves capabilities
3. Runtime spawns `claude` CLI with the prompt + MCP configs
4. Result (text + session ID + usage) is returned and persisted

Session IDs enable multi-turn conversations. On resumption, resolvers and the system prompt are skipped (the runtime has prior context).

## Workspace

The agent's workspace is `~/.caddie/` by default (override with `WORKSPACE_DIR`) — outside the repo, since a workspace is the agent's data, not app code. All profiles share it. It contains:

- `config/` -- persistent config files (editable via the control plane)
- `jobs/` -- recurring-job procedures, one `<job>.md` each (written by you)
- `.claude/` -- symlinked skills and hooks from the agent definition
- `conversations/` -- one markdown file per conversation message, mirrored from Postgres for search (derived; rebuilt on startup)
- `.rag/` -- the search index, its embedding-model cache and sync manifest (derived; `make rag-rebuild`)
- Everything else -- created by the agent during runs (task files, memory, run records, etc.)

Override the workspace location with `WORKSPACE_DIR`:

```bash
make run WORKSPACE_DIR=/path/to/workspace
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
make keep-awake   # keep this Mac running with its lid closed (sudo); make allow-sleep undoes it
make rag-setup    # build the optional workspace search server
make rag-rebuild  # drop and rebuild the search index
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
cd harness && pnpm smoke                                          # base configuration
cd harness && pnpm smoke -- --profile extended --prompt "..."     # a profile and prompt
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
| **Public internet** | Tailscale **Funnel** on `:443` | Only the ingress webhooks: `/api/telegram/webhook`, `/api/chat/plugins/slack/interactions`, `/api/chat/plugins/linear/webhook`, and the Linear install redirect `/api/chat/plugins/linear/oauth_redirect` |
| **Your tailnet + this machine** | Tailscale **Serve** on `:8443` | The full control plane — dashboards, control API, all other endpoints |
| **This machine only** | direct | `http://localhost:3000` |

Third-party services (Telegram, Slack, Linear) can only reach those paths.
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
run `make unexpose`. It requires the `tailscale` daemon and a tailnet with
Funnel enabled — [docs/SETUP.md](docs/SETUP.md#6-tailscale) sets both up; if `tailscale` isn't
installed, `make run` still starts the server localhost-only (webhooks just won't
be reachable from the internet). Tune via make variables `FUNNEL_PATHS`,
`TAILNET_PORT`, `CADDIE_PORT`. Verify the live config with
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
