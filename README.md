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
├── northstar/            # Control plane + gateway (Next.js)
├── workspace/            # Agent working directories (gitignored)
└── sandcastle/           # Security investigation project
```

## Quick Start

```bash
pnpm install              # install dependencies
make run                  # start Northstar on http://localhost:3000
make smoke                # run a smoke test directly via the harness
```

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
      "capabilities": ["chrome"],
      "mode": "triggered"
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
| `outputSchema` | no | JSON Schema for structured output. Omit for conversational mode |
| `mode` | no | `"conversational"` (default) or `"triggered"` -- controls the UI |
| `profiles` | no | Named profile overrides. Each profile can override `capabilities`, `resolvers`, `maxTurns`, `mode`, etc. |

### Profiles

Profiles let a single agent serve multiple roles. Each profile overrides the base config for the fields it specifies. Activate a profile by passing `profile` to the launcher or gateway:

```bash
# Run buri with the writer profile (notion + web-search, maxTurns: 30)
curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri","profile":"writer"}'

# Run buri with xmanager profile (chrome, triggered mode)
curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri","profile":"xmanager"}'

# Run buri with no profile (default: notion + google-calendar resolver)
curl -X POST localhost:3000/api/gateway -d '{"action":"run","agentId":"buri"}'
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
│  │ Dashboard │  │ Gateway   │  │ Postgres + Redis │ │
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

**Northstar** imports the harness as a workspace dependency. The gateway API (`/api/gateway`) is the single entry point for running agents, sending notifications, and managing schedules. Agents with orchestration logic have dedicated orchestrators that handle Slack posting, scheduling, and multi-step execution.

### Execution flow

1. Gateway receives a request (action + agent ID + optional profile)
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
make run          # start Northstar on http://localhost:3000
make build        # build harness + northstar
make install      # install all dependencies
make smoke        # run a quick smoke test via the harness
```

Or directly:

```bash
cd northstar && pnpm dev                                      # start Northstar
cd harness && pnpm smoke                                      # default: buri agent
cd harness && pnpm smoke -- --agent buri --prompt "..."       # specify agent and prompt
```

## Prerequisites

- **Node.js** and **pnpm** (10.22+)
- **`claude` CLI** on PATH -- the Claude Code CLI is the current runtime driver
- **Postgres** -- `POSTGRES_URL` in `northstar/.env.local`
- **Redis** -- `REDIS_URL` in `northstar/.env.local`
- **Env vars for capabilities** -- e.g., `NOTION_INTERNAL_TOKEN` for Notion. Missing vars produce warnings, not errors.
