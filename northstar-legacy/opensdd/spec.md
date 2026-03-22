# northstar

> A unified AI agent that manages calendar, tasks, workspace knowledge, and social media presence through a modular agent runtime with composable tools and process-specific skills.

## Behavioral Contract

### 1. Unified Agent Architecture

The system MUST operate as a single agent (not separate Calendar Manager and X Manager agents). Domain-specific capabilities are exposed as **tools** (discrete operations) and **skills** (multi-step processes with embedded guidance).

#### 1.1 Core Agent

- The system MUST define an **Agent Runtime** interface that encapsulates the agent loop (LLM interaction, tool execution, and response generation). The runtime is the replaceable engine; the execution services are the stable harness.
- The Agent Runtime interface MUST accept:
  - `prompt` (string): The full task prompt including persona, context, and instructions.
  - `outputSchema` (JSON Schema): The expected structure of the agent's final output.
  - `maxTurns` (number): Maximum agent loop iterations before forced termination.
  - `workingDirectory` (string): The directory the agent operates in (defaults to the workspace directory).
  - `sessionId` (string, optional): If provided, the runtime MUST resume a previous session instead of starting a new one.
  - `mcpServers` (MCP server configuration, optional): Additional MCP tool integrations (e.g., Notion).
- The Agent Runtime interface MUST return:
  - `output` (object): The structured output matching `outputSchema`, or `null` if the agent failed to produce valid output.
  - `sessionId` (string): The session identifier for this execution, usable for resumption.
  - `rawText` (string): The agent's full text response.
  - `error` (string, optional): Error description if the execution failed.
- The system MUST ship with a **Claude Code CLI runtime** as the default implementation:
  - It MUST invoke `claude` via the `-p` (print/non-interactive) flag.
  - It MUST pass `--output-format json` and `--json-schema` for structured output.
  - It MUST pass `--max-turns` to enforce the turn limit.
  - It MUST support `--resume <sessionId>` for conversation continuity.
  - It MUST authenticate via the locally configured Claude Code OAuth token (from `claude login`). It MUST NOT require an `ANTHROPIC_API_KEY`.
  - It MAY pass `--model` to select a specific Claude model.
  - It MUST enable Chrome browser automation when browser tools are needed (e.g., X Manager skills).
- The runtime MUST be configurable per deployment (e.g., via environment variable or app config), allowing operators to swap the underlying engine without changing orchestration code.
- The agent MUST support two execution modes:
  - **Check-in mode**: Agent-initiated, scheduled interactions where the agent reviews the user's context and proactively surfaces relevant information.
  - **Conversation mode**: User-initiated interactions where the user replies in a Slack thread. The system resumes the original agent session so the agent retains full prior context.
- The agent MUST return structured output at the end of every execution. The structure is defined by an `outputSchema` provided to the runtime.
- The agent MUST track active runs via Redis to prevent concurrent executions for the same user.

#### 1.2 Persona

- The agent presents as an effective, high-performing people manager.
- Tone: warm but efficient, familiar, concise, detail-oriented.
- The agent maintains memory about the user (work style, preferences, organization) via workspace files and uses it to personalize interactions.

#### 1.3 Session Management

- The system MUST store a mapping of session ID to Slack message ID (thread timestamp) after each agent-initiated run (check-in, X Manager).
- When a user replies in a Slack thread tied to an agent message, the system MUST look up the session ID for that thread and resume the agent session.
- Session mappings MUST be stored in a persistent store (Redis or PostgreSQL).
- Session mappings MAY expire after a configurable TTL (suggested: 7 days).
- If a session cannot be resumed (e.g., expired or corrupted), the system MUST start a fresh session and inform the user that prior context was lost.

### 2. Tools

Each tool is a discrete, stateless operation the agent can invoke. Tools do not embed process logic — they perform a single action and return results.

#### 2.0 Tool Sets

The agent's tools come from two sources: **built-in runtime tools** (file operations, web search, browser automation provided natively by the Agent Runtime) and **MCP servers** (external integrations like Notion that require specific API clients). The execution service composes the tool environment by choosing the right working directory and optionally attaching MCP servers.

| Capability | Source | Used By |
|------------|--------|---------|
| File read/write/list/create | Runtime built-in (scoped to workspace directory) | Check-in, conversation, X Manager |
| Web search | Runtime built-in | Check-in, conversation, X Manager |
| Browser automation (Chrome) | Runtime built-in (Chrome integration) | X Manager skills |
| Calendar events | Pre-fetched context injected into prompt | Check-in, conversation |
| Notion search/read | Notion MCP server (attached when available) | Check-in, conversation |

- The workspace directory MUST be set as the runtime's working directory so that built-in file tools are scoped to the user's workspace.
- MCP servers (e.g., Notion) MUST be independently initializable — if Notion auth is unavailable, the agent proceeds without it.
- Adding a new integration means either leveraging an existing runtime built-in or attaching a new MCP server — no changes to the runtime interface.

#### 2.1 Calendar Context

Calendar data is pre-fetched by the execution service and injected into the skill prompt as context. There are no runtime calendar tools.

- The execution service MUST fetch today's calendar events from Google Calendar before rendering the skill prompt.
- Calendar fetching MUST authenticate via stored OAuth credentials with automatic token refresh.
- All times MUST be displayed in PST (America/Los_Angeles).
- If calendar fetching fails, the prompt MUST include a note that calendar data was unavailable (not a silent omission).

#### 2.2 Notion Tools

Notion access is provided via a Notion MCP server attached to the runtime when available:

| Tool | Description |
|------|-------------|
| `notion_search` | Search pages by title or content. |
| `notion_query_database` | Query a Notion database for tasks/projects. |
| `notion_read_page` | Read full page content and comments. |

- Notion tools MUST support both internal integration tokens and OAuth authentication.
- During check-ins, all accessible Notion pages are also pre-fetched and injected as baseline context in the prompt.
- If Notion MCP fails to initialize (e.g., no token configured), the agent MUST proceed without Notion tools.

#### 2.3 Workspace (Filesystem)

Workspace access uses the Agent Runtime's built-in file tools. The runtime's working directory is set to the user's workspace directory.

- The workspace directory MUST default to `<northstar-root>/workspace/` and be configurable via environment variable.
- The workspace SHOULD be scoped per user by convention (e.g., `workspace/<userId>/`). Isolation is best-effort, not a hard security boundary.
- Workspace MUST support organized storage for daily tasks, user memory, and X Manager run data.
- The agent interacts with workspace files using the runtime's native file operations (read, write, list, create).

#### 2.4 Browser Tools

Browser automation uses the Agent Runtime's built-in Chrome integration (e.g., Claude Code's Chrome support).

- The runtime MUST be configured to enable Chrome browser automation for skills that require it (X Manager feed scan, metrics check).
- Browser tools operate on the locally running Chrome instance with Claude-in-Chrome (or equivalent) enabled.
- The agent MUST use a pre-authenticated browser session. The agent MUST NOT attempt to log into X programmatically — login is a separate, user-initiated flow.

#### 2.5 Web Search

Web search uses the Agent Runtime's built-in web search capability.

- Web search is for information retrieval only — for interacting with web pages (clicking, typing, screenshots), use browser tools.

#### 2.6 Structured Output Schemas

Instead of a dedicated finish tool, each execution mode defines a **JSON Schema** for its expected output. The Agent Runtime validates and returns the structured output.

**Check-in / Conversation output schema:**
```json
{
  "type": "object",
  "properties": {
    "message": { "type": "string", "description": "The agent's response to the user." },
    "nextCheckInTime": { "type": "number", "description": "Minutes until the next scheduled check-in. Omit or set to null for conversation mode." }
  },
  "required": ["message"]
}
```

**X Manager sub-task output schema:**
```json
{
  "type": "object",
  "properties": {
    "summary": { "type": "string", "description": "Brief summary of what the sub-task accomplished." },
    "itemsFound": { "type": "number", "description": "Number of items written to the run record." }
  },
  "required": ["summary", "itemsFound"]
}
```

**X Manager orchestration output schema:**
```json
{
  "type": "object",
  "properties": {
    "slackMessage": { "type": "string", "description": "Slack-formatted digest of the run." },
    "runRecordPath": { "type": "string", "description": "Path to the JSONL run record file." },
    "nextRunMinutes": { "type": "number", "description": "Minutes until the next scheduled X Manager run." }
  },
  "required": ["slackMessage", "runRecordPath"]
}
```

- If the runtime fails to produce output matching the schema, the execution MUST be treated as a failure.

### 3. Skills

Skills are multi-step processes with embedded procedural guidance. Unlike tools, skills encode *how* to accomplish a complex workflow. Each skill is expressed as a **prompt template** — a structured user prompt that includes persona, context variables, and step-by-step instructions. The execution service renders the template with runtime context (current time, calendar data, file paths, etc.) and passes it to the Agent Runtime as the `prompt` argument.

- Skill prompts MUST be self-contained: they include persona, behavioral guidance, and procedural steps in a single prompt.
- Skill prompts MUST use template variables (e.g., `{{currentTime}}`, `{{calendarEvents}}`) for dynamic context that the execution service fills in before passing to the runtime.
- Skill prompts MAY be stored as separate files (e.g., `lib/agents/skills/check-in.prompt.md`) for readability and version control.
- Skill prompts MAY additionally be managed in Langfuse for A/B testing and version management, with local files as fallback.

#### 3.1 Check-In Skill

**Trigger**: Scheduled check-in or user requests a status review.

**Output schema**: Check-in output schema (§2.6).

**Process**:
1. *(Pre-flight, done by execution service)* Fetch today's calendar events and Notion pages, inject into prompt as context.
2. Read the user's daily task file for today (`tasks/YYYY-MM/D_dayname.txt`).
3. Read memory files (`memory/user.txt`, `memory/organization.txt`) to personalize.
4. Review calendar context for upcoming deadlines, conflicts, or gaps.
5. Ask the user for updates on pending tasks.
6. Probe for blockers, uncertainties, or issues preventing progress.
7. Record any task updates or notes to the daily file.
8. Update memory files if new observations about the user emerge (with timestamps).
9. Determine next check-in time based on user's schedule and workload.
10. Return structured output with the response `message` and `nextCheckInTime`.

**Scheduling guidance**:
- No more than one check-in every few hours.
- No fewer than one check-in per work day.
- Adjust based on user's stated preferences, meeting density, and task urgency.

#### 3.2 X Feed Scan Skill

**Trigger**: Agent determines it's time to scan X feeds (as part of an X Manager run).

**Output schema**: X Manager sub-task output schema (§2.6).

**Process**:
1. Use browser tools to navigate to `https://twitter.com`.
2. Scan the "For You" feed:
   - Page down up to 10 times or until 3+ opportunities found.
   - Only consider posts from the last 12 hours.
   - Apply engagement criteria and areas of interest.
3. Switch to "Following" feed, sort by recency, repeat scanning.
4. Switch to "Build in Public" feed, sort by recency, repeat scanning.
5. For each engagement opportunity, append a JSONL line to the run record file:
   ```json
   {"type":"opportunity","author":"...","authorHandle":"...","text":"...","link":"...","reason":"..."}
   ```
6. Click into threads or profiles as needed for context.
7. Return structured output with `summary` and `itemsFound`.

#### 3.3 X Metrics Check Skill

**Trigger**: Agent determines it's time to check X post metrics (as part of an X Manager run).

**Output schema**: X Manager sub-task output schema (§2.6).

**Process**:
1. Use browser tools to navigate to `https://twitter.com/{xUsername}` (user's profile).
2. Identify posts from the last 24 hours (configurable).
3. Click into each recent post to view full metrics.
4. For each post, append a JSONL line to the run record file:
   ```json
   {"type":"metric","postLink":"...","postText":"...","impressions":0,"likes":0,"replies":0,"retweets":0,"engagementRate":0.0}
   ```
5. If no recent posts exist, finish without writing anything.
6. Return structured output with `summary` and `itemsFound`.

#### 3.4 X Manager Orchestration

**Trigger**: Scheduled X Manager run or user requests an X scan. Unlike other skills, the orchestration is implemented in the execution service, not as a single agent prompt. The execution service dispatches feed scan and metrics check as sequential Agent Runtime invocations.

**Process (execution service responsibility)**:
1. Read configuration files from workspace: `config/areas_of_interest.md`, `config/engagement_criteria.md`.
2. Read insight files: `insights/reply_strategy.txt`, `insights/performance_log.txt`.
3. Retrieve last run state from Redis (timestamp, summary).
4. Create a timestamped run record file: `runs/YYYY-MM/D_dayname/run-record-TIMESTAMP.jsonl`.
5. Execute sequentially via separate Agent Runtime invocations (each with Chrome enabled):
   a. **Feed Scan** (skill 3.2) — rendered prompt with areas of interest, engagement criteria, and run record path.
   b. **Metrics Check** (skill 3.3) — rendered prompt with X username and run record path.
6. Read the completed run record file and parse JSONL entries.
7. Generate a Slack-formatted digest message with sections:
   - Engagement Opportunities (with reasons and links)
   - Recent Post Performance (with metrics)
8. Update insight files based on run results.
9. Store run state in Redis (timestamp, summary).
10. Schedule the next X Manager run (production only).
11. Return the Slack message and run record.

### 4. API Surface

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/agent/run` | Trigger a check-in. |
| POST | `/api/agent/continue` | Continue a conversation with the agent. |
| POST | `/api/agent/webhook` | Webhook trigger for scheduled check-ins. |
| POST | `/api/xmanager/run` | Trigger an X Manager run. |
| GET  | `/api/xmanager/status` | Get X Manager run status. |
| POST | `/api/xmanager/schedule` | Schedule/manage X Manager runs. |
| POST | `/api/xmanager/cancel` | Cancel an active X Manager run. |
| POST | `/api/xmanager/login` | Open browser for X login flow. |
| GET  | `/api/auth/status` | Check OAuth connection status. |
| GET  | `/api/auth/google` | Initiate Google OAuth flow. |
| GET  | `/api/auth/google/callback` | Google OAuth callback. |
| GET  | `/api/auth/notion` | Initiate Notion OAuth flow. |
| GET  | `/api/auth/notion/callback` | Notion OAuth callback. |
| POST | `/api/auth/disconnect` | Disconnect an OAuth provider. |
| GET/PUT | `/api/settings/xmanager` | Get/update X Manager settings. |
| GET/PUT | `/api/settings/xmanager/areas-of-interest` | Get/update areas of interest. |
| GET/PUT | `/api/settings/xmanager/engagement-criteria` | Get/update engagement criteria. |
| GET/PUT | `/api/settings/slack-channel` | Get/update Slack channel settings. |

### 5. Run Lifecycle

#### 5.1 Check-In Run
1. The system MUST reject the request if an active run exists for the user.
2. The system MUST acquire a run lock before execution and release it after completion (including on failure).
3. The system MUST pre-fetch context (calendar events, Notion pages) and render the check-in skill prompt template.
4. The system MUST invoke the Agent Runtime with the rendered prompt, workspace directory, check-in output schema, Notion MCP (if available), and max turns.
5. The system MUST extract the structured output and schedule the next check-in based on `nextCheckInTime`.
6. The system MUST store the session ID ↔ Slack message ID mapping for conversation resumption.
7. The system MUST post the agent's response to Slack.
8. If the run fails for any reason, the system MUST post a failure message to Slack indicating the reason.

#### 5.2 X Manager Run
1. The system MUST validate that an X username is configured before proceeding.
2. The system MUST reject the request if an active X Manager run exists for the user.
3. The system MUST acquire a run lock before execution and release it after completion (including on failure).
4. The system MUST load configuration (areas of interest, engagement criteria, insights, last run state) before executing skills.
5. The system MUST invoke each sub-task (feed scan, metrics check) as a separate Agent Runtime call with Chrome enabled, the workspace directory, and the sub-task output schema.
6. The system MUST read the completed run record and generate the Slack digest in the execution service.
7. The system MUST post the digest to Slack and store the session ID mapping.
8. If the run fails for any reason, the system MUST post a failure message to Slack indicating the reason.
9. The system MUST return a Slack-formatted digest and the run record.

## Edge Cases

- **Runtime unavailable**: If the configured Agent Runtime is not available (e.g., `claude` CLI not installed, OAuth token expired, rate limited), the system MUST post a failure message to Slack indicating the reason and treat the execution as failed. No automatic retry.
- **Structured output validation failure**: If the runtime returns output that does not match the expected schema, the execution MUST be treated as a failure. The system MUST log the raw output for debugging and post a failure notice to Slack.
- **Session resumption failure**: If a Slack thread reply references a session that cannot be resumed (expired, corrupted, or missing), the system MUST start a fresh session and inform the user that prior context was lost.
- **No calendar events today**: The check-in skill MUST still execute and provide value from other context sources (Notion, tasks, memory).
- **Notion unavailable**: If Notion MCP fails to initialize, the agent MUST proceed without Notion tools. Notion is not required for execution.
- **Chrome unavailable**: If Chrome browser automation is not available during an X Manager run, the run MUST fail with a clear error posted to Slack.
- **Empty run record**: If a feed scan or metrics check produces no results, the X Manager orchestration MUST still generate a Slack digest noting that no opportunities or metrics were found.
- **Concurrent run attempt**: If a run is attempted while another is active for the same user, the system MUST reject with an error (not queue or wait).
- **Agent reaches max turns without producing structured output**: The execution MUST be treated as a failure.
- **Stale Redis lock**: If a run lock exists but no execution is active (e.g., after a crash), the system SHOULD provide a mechanism to clear stale locks.

## NOT Specified (Implementation Freedom)

- **Model selection logic**: Which specific model to use for which task. The spec does not prescribe model selection — this is determined by the runtime configuration.
- **Prompt wording**: Exact phrasing of skill prompts. The spec defines behavior, not prose.
- **Prompt management**: How prompts are stored, versioned, or managed (local files, Langfuse, etc.).
- **Runtime implementation details**: Internal mechanics of each Agent Runtime implementation (process management, error formatting). The spec defines the interface contract, not the internals.
- **Alternative runtime implementations**: The spec requires a modular interface and a Claude Code CLI default, but does not prescribe how other runtimes (Codex, Gemini, custom loops) are implemented.
- **Session storage backend**: Whether session ID ↔ Slack message ID mappings are stored in Redis, PostgreSQL, or another store.
- **Insight file update algorithm**: How run results are analyzed to update `reply_strategy.txt` and `performance_log.txt`. Currently stubbed.
- **Slack message formatting details**: Exact Slack markdown/mrkdwn formatting beyond the required sections.
- **Error recovery strategies**: How the agent recovers from partial failures (e.g., one sub-skill fails during X Manager orchestration). Currently errors are caught and logged, execution continues.
- **Memory file pruning heuristics**: When and how to trim old entries from memory files.
- **Feed pagination strategy**: Exact scroll behavior, wait times between pages, detection of "no more content."
- **UI/Frontend**: The spec covers the backend agent system only. Any dashboard, settings UI, or chat interface is out of scope.

## Invariants

1. **Single active run**: At most one agent execution (check-in OR conversation) may be active per user at any time. Enforced via Redis locks.
2. **Single active X Manager run**: At most one X Manager run may be active per user at any time. Independent from the check-in lock.
3. **Structured output required**: Every agent execution MUST produce structured output matching the execution mode's schema. If the runtime fails to produce valid output, the execution is treated as a failure.
4. **Run record immutability**: Once a run record JSONL file is written and finalized, it MUST NOT be modified. New runs create new files.
5. **Authenticated browser sessions**: Browser tools MUST operate within a pre-authenticated session. The agent MUST NOT attempt to log into X programmatically — login is a separate, user-initiated flow.
6. **Timestamp consistency**: All timestamps in run records, file names, and scheduling MUST use ISO 8601 format. Display times for the user use PST.
7. **Workspace scoping**: Each user's workspace is scoped by convention (working directory set to user's workspace). Isolation is best-effort, not a hard security boundary.
8. **Failure reporting**: If an agent execution fails for any reason, the system MUST post a failure message to Slack with the reason. No silent failures.
9. **Graceful cleanup**: MCP clients MUST be closed in `finally` blocks regardless of execution outcome.
10. **Sequential X Manager sub-skills**: Feed scan and metrics check MUST execute sequentially (not in parallel).
11. **Runtime modularity**: The orchestration layer (execution services) MUST NOT contain runtime-specific logic. All runtime interaction MUST go through the Agent Runtime interface.

## Implementation Hints

- **Google Calendar**: OAuth 2.0 with stored credentials in database. Automatic token refresh on expiry. Primary calendar only. Data is pre-fetched by the execution service and injected into skill prompts as context.
- **Notion**: Dual auth support — internal integration token OR OAuth. MCP-based tool access (local stdio server). Attached to the runtime as an optional MCP server.
- **Browser automation**: Claude Code's built-in Chrome integration (Claude-in-Chrome). Requires the Chrome extension to be installed and enabled on the host machine. Uses the local Chrome profile for pre-authenticated sessions.
- **Web search**: Claude Code's built-in web search. No additional configuration needed.
- **Filesystem**: Local filesystem via Claude Code's built-in file tools. Working directory set to the user's workspace directory under `<northstar-root>/workspace/`.
- **Redis**: Used for active run tracking, check-in scheduling, X Manager run state, and session ID ↔ Slack message ID mappings.
- **Prompt management**: Skill prompts stored as `.prompt.md` template files. Optionally managed in Langfuse for versioning and A/B testing.
- **Claude Code CLI runtime**: Invoke via `child_process.execFile("claude", ["-p", prompt, "--output-format", "json", "--json-schema", schema, "--max-turns", N])`. Parse JSON from stdout. Handle non-zero exit codes as failures. Ensure `claude` is on PATH or configurable via environment variable.
- **Removed dependencies**: The migration removes `@openrouter/ai-sdk-provider`, `ai` (Vercel AI SDK), and related adapter code (`openrouter-client.ts`, `unified-agent.ts`, `tool-sets.ts`, `agent-tools.ts`). The `OPENROUTER_API_KEY` environment variable is no longer required.
- **Workspace directory structure**:
  ```
  <northstar-root>/workspace/<userId>/
  ├── tasks/YYYY-MM/D_dayname.txt
  ├── memory/{organization,user,notes}.txt
  └── xmanager/{config,insights,runs}/...
  ```
