# Northstar

Control plane and API gateway for the agints workflow system. Built with Next.js.

## What It Does

Northstar serves two roles:

1. **API Gateway** -- API routes trigger workflow executions by calling into the Agent Harness. External systems (cron jobs, webhooks, the dashboard) hit these endpoints to launch or continue conversations with workflows.

2. **Control Plane UI** -- A React dashboard for managing workflows, viewing conversations, and configuring settings. Workflows are auto-discovered from `harness/workflows/` -- no registration needed.

## How It Integrates with the Harness

Northstar imports `@agints/harness` as a pnpm workspace dependency. A shared launcher instance is created on first use:

```typescript
import { createRuntime, createLauncher } from "@agints/harness";

const runtime = createRuntime();
const launcher = createLauncher(runtime, {
  workflowsDir: resolve(harnessRoot, "workflows"),
  capabilitiesDir: resolve(harnessRoot, "capabilities"),
  workspaceRoot: resolve(process.cwd(), "workspace"),
});
```

API routes call `launcher.launch({ workflowId, prompt, sessionId })` to execute workflows. See `lib/harness.ts` for the integration code.

## Data Storage

Conversations are stored in Postgres using JSONB columns for message history. Each conversation tracks:

- The workflow ID and user
- Message history (user prompts + agent responses)
- Claude Code session ID for multi-turn resumption

Connection string is configured via `POSTGRES_URL` in `.env.local`.

## Running

```bash
pnpm dev    # http://localhost:3000
```

Requires `POSTGRES_URL` in `.env.local` and the `claude` CLI on PATH.
