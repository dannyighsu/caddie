# agints

Workflows and agents that run the business. Each workflow is a declarative config (JSON + persona prompt) that the Agent Harness executes via an underlying runtime (currently Claude Code CLI).

## Table of Contents

- [Repository Structure](#repository-structure)
- [Quick Start](#quick-start)
- [Creating a Workflow](#creating-a-workflow)
- [Adding a Capability](#adding-a-capability)
- [Architecture](#architecture)
- [Running](#running)
- [Prerequisites](#prerequisites)

## Repository Structure

```
agints/
├── harness/              # Agent Harness library (@agints/harness)
│   ├── src/              # Runtime, launcher, capability resolver
│   ├── capabilities/     # MCP server configs (JSON files)
│   ├── workflows/        # Workflow definitions (workflow.json + persona.md)
│   └── scripts/run.ts    # CLI smoke test
├── northstar/            # Control plane + API gateway (Next.js)
└── sandcastle/           # Security investigation project
```

## Quick Start

```bash
# Install dependencies
pnpm install

# Run the control plane (dashboard + API)
cd northstar && pnpm dev    # http://localhost:3000

# Or run a workflow directly without the control plane
cd harness && pnpm smoke
cd harness && pnpm smoke -- --workflow writer --prompt "Draft a thread about AI agents"
```

## Creating a Workflow

A workflow is a directory under `harness/workflows/` containing two files: a config and a persona.

### 1. Create the workflow directory

```
harness/workflows/<id>/
├── workflow.json
└── persona.md
```

### 2. Define workflow.json

```json
{
  "id": "writer",
  "name": "Content Writer",
  "persona": "./persona.md",
  "capabilities": ["notion", "web-search"],
  "maxTurns": 30
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Unique identifier, matches the directory name |
| `name` | yes | Human-readable name shown in the dashboard |
| `persona` | yes | Path to persona markdown (relative to workflow dir), or an inline string |
| `capabilities` | yes | List of capability names (references JSON files in `harness/capabilities/`) |
| `maxTurns` | no | Max agent loop iterations before forced stop. Default: 20 |
| `enableChrome` | no | Enable Chrome browser automation. Can also be set via the `chrome` capability |
| `outputSchema` | no | JSON Schema for structured output. Omit for conversational mode |

### 3. Write persona.md

The persona is the system prompt. It supports `{{templateVar}}` interpolation -- the caller passes a `context` map and variables are replaced at launch time.

```markdown
# Persona: Content Strategist

You are a skilled content strategist helping the user brainstorm, research, draft,
and refine articles for X/Twitter, Medium, and LinkedIn.

## Current Context
Current time: {{currentTime}}

## Guidelines
- Ask clarifying questions before diving into a draft
- Cite sources when making factual claims
- Save drafts to the workspace for iteration
```

Unresolved `{{variables}}` are left as-is (not stripped), so you can spot missing context easily.

### 4. Done

The workflow auto-appears in the Northstar dashboard. No registration step, no database entry -- the harness reads `harness/workflows/` at runtime.

## Adding a Capability

Capabilities are MCP server configurations. Each is a JSON file in `harness/capabilities/` that workflows reference by name.

### MCP server capability

Create `harness/capabilities/<name>.json`:

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

`${ENV_VAR}` references in `command`, `args`, and `env` values are resolved from `process.env` at runtime. Missing env vars produce a warning but do not block execution.

### Flag-only capability

Some capabilities do not start an MCP server -- they just enable a runtime flag. Omit the `server` field:

```json
{
  "name": "chrome",
  "description": "Chrome browser automation (enables --chrome flag on Claude Code runtime)"
}
```

The harness checks for flag capabilities and passes them to the runtime accordingly.

### Using capabilities in a workflow

Reference capability names in the workflow's `capabilities` array:

```json
{
  "id": "researcher",
  "name": "Deep Researcher",
  "persona": "./persona.md",
  "capabilities": ["web-search", "notion", "chrome"]
}
```

### Current capabilities

| Name | Type | Description |
|------|------|-------------|
| `notion` | MCP server | Notion workspace access (`@notionhq/notion-mcp-server`) |
| `web-search` | MCP server | Web search and fetching (`@anthropic-ai/fetch-mcp`) |
| `chrome` | Flag | Enables Chrome browser automation in the runtime |

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Northstar (Next.js)                            │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ Dashboard │  │ API Routes│  │ Postgres     │ │
│  │ (React)   │  │ (Gateway) │  │ Conversations│ │
│  └──────────┘  └─────┬─────┘  └──────────────┘ │
└───────────────────────┼─────────────────────────┘
                        │ imports @agints/harness
┌───────────────────────┼─────────────────────────┐
│  Agent Harness        │                         │
│                       ▼                         │
│  ┌────────────────────────────┐                 │
│  │ Launcher                   │                 │
│  │ load workflow.json          │                 │
│  │ → read persona.md           │                 │
│  │ → interpolate {{vars}}      │                 │
│  │ → resolve MCP capabilities  │                 │
│  │ → call runtime.execute()    │                 │
│  └─────────────┬──────────────┘                 │
│                │                                │
│  ┌─────────────▼──────────────┐                 │
│  │ AgentRuntime (interface)   │                 │
│  │                            │                 │
│  │ ClaudeCodeRuntime          │                 │
│  │ (claude CLI → subprocess)  │                 │
│  └────────────────────────────┘                 │
└─────────────────────────────────────────────────┘
```

**Harness** is a pure TypeScript library with no framework dependencies. It exposes two main functions:

- `createRuntime()` -- instantiates an `AgentRuntime` (currently always `ClaudeCodeRuntime`)
- `createLauncher(runtime, config)` -- returns a `{ launch }` function bound to workflow and capability directories

The `AgentRuntime` interface is intentionally minimal:

```typescript
interface AgentRuntime {
  readonly name: string;
  execute(input: AgentRuntimeInput): Promise<AgentRuntimeOutput>;
}
```

This makes it straightforward to add runtimes for other engines (Codex, local models, etc.) without changing the launcher or workflow definitions.

**Northstar** imports the harness as a pnpm workspace dependency. API routes call `getLauncher().launch()` to trigger workflows. The frontend lists available workflows by scanning the `harness/workflows/` directory. Conversations (messages, session IDs for multi-turn resumption) are stored in Postgres with JSONB columns.

### Execution flow

1. API route receives a request (workflow ID + prompt + optional session ID)
2. `getLauncher().launch()` is called
3. Launcher loads `workflow.json`, reads and interpolates `persona.md`, resolves MCP capabilities
4. Runtime receives the full prompt + MCP server configs and executes the agent loop
5. Result (structured output or raw text + session ID) is returned and persisted

Session IDs enable multi-turn conversations. On resumption, the persona is skipped (the runtime already has prior context) and only the new user prompt is sent.

## Running

### Control plane (Northstar)

```bash
cd northstar
pnpm dev
```

Starts the dashboard and API gateway on `http://localhost:3000`.

### Direct workflow execution

```bash
cd harness
pnpm smoke                                                    # default: writer workflow
pnpm smoke -- --workflow writer --prompt "Write about X"      # specify workflow and prompt
```

Runs a workflow directly via the harness without going through Northstar. Useful for testing new workflows.

## Prerequisites

- **Node.js** and **pnpm** (10.22+)
- **`claude` CLI** on PATH -- the Claude Code CLI is the current runtime driver
- **Postgres** -- connection string in `northstar/.env.local` as `POSTGRES_URL`
- **Env vars for capabilities** -- e.g., `NOTION_INTERNAL_TOKEN` for the Notion capability. Set in `.env.local` or your shell environment. Missing vars produce warnings, not errors.
