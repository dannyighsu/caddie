# northstar

> A unified AI agent that manages calendar, tasks, workspace knowledge, and social media presence through a single agent with composable tools and process-specific skills.

## Behavioral Contract

### 1. Unified Agent Architecture

The system MUST operate as a single agent (not separate Calendar Manager and X Manager agents). Domain-specific capabilities are exposed as **tools** (discrete operations) and **skills** (multi-step processes with embedded guidance).

#### 1.1 Core Agent

- The agent MUST have a single system prompt that defines its persona and general behavior.
- The agent MUST be able to use any combination of tools in a single session.
- The agent MUST support two execution modes:
  - **Check-in mode**: Agent-initiated, scheduled interactions where the agent reviews the user's context and proactively surfaces relevant information.
  - **Conversation mode**: User-initiated interactions where the agent responds to messages with full tool access.
- The agent MUST call a `finish` tool at the end of every execution to return structured output (response message and optional scheduling info).
- The agent MUST track active runs via Redis to prevent concurrent executions for the same user.

#### 1.2 Persona

- The agent presents as an effective, high-performing people manager.
- Tone: warm but efficient, familiar, concise, detail-oriented.
- The agent maintains memory about the user (work style, preferences, organization) via workspace files and uses it to personalize interactions.

### 2. Tools

Each tool is a discrete, stateless operation the agent can invoke. Tools do not embed process logic — they perform a single action and return results.

#### 2.0 Tool Sets

Tools are organized into **tool sets** — modular groups that can be composed depending on the execution context. This allows the agent to be configured with only the tools relevant to a given run, rather than always receiving every tool.

| Tool Set | Contains | Used By |
|----------|----------|---------|
| `calendarTools` | `get_today_events`, `get_upcoming_events`, `get_events_in_range` | Check-in, conversation |
| `notionTools` | `notion_search`, `notion_query_database`, `notion_read_page` | Check-in, conversation |
| `workspaceTools` | `read_file`, `write_file`, `list_directory`, `create_directory` | Check-in, conversation, X Manager |
| `browserTools` | `browser_navigate`, `browser_click`, `browser_type`, `browser_screenshot`, `browser_scroll`, `browser_close_all` | X Manager skills |
| `finishTools` | `finish` | All executions |

- Tool sets MUST be composable: the agent's tool configuration is built by merging the required tool sets for a given execution mode.
- Each tool set MUST be independently initializable (e.g., `browserTools` requires a browser MCP client, `notionTools` requires Notion auth — neither should block the other from loading).
- Adding a new integration means defining a new tool set and registering it in the relevant execution modes — no changes to the agent core.

#### 2.1 Calendar Tools

| Tool | Description |
|------|-------------|
| `get_today_events` | Fetch today's calendar events from Google Calendar. Returns structured `CalendarEvent[]`. |
| `get_upcoming_events` | Fetch upcoming events with configurable `maxResults`. |
| `get_events_in_range` | Fetch events between `startDate` and `endDate`. |

- All calendar tools MUST authenticate via stored OAuth credentials with automatic token refresh.
- All times MUST be displayed in PST (America/Los_Angeles).
- Calendar data is also injected as baseline context during check-ins (via `get_today_events`).

#### 2.2 Notion Tools

Notion access is provided via MCP (Model Context Protocol) tools:

| Tool | Description |
|------|-------------|
| `notion_search` | Search pages by title or content. |
| `notion_query_database` | Query a Notion database for tasks/projects. |
| `notion_read_page` | Read full page content and comments. |

- Notion tools MUST support both internal integration tokens and OAuth authentication.
- During check-ins, all accessible Notion pages are fetched as baseline context.

#### 2.3 Workspace (Filesystem) Tools

Workspace access is provided via MCP:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file from the user's workspace. |
| `write_file` | Write/update a file in the user's workspace. |
| `list_directory` | List files in a workspace directory. |
| `create_directory` | Create a directory in the workspace. |

- The workspace MUST be scoped per user — one user's agent MUST NOT access another user's files.
- Workspace MUST support organized storage for daily tasks, user memory, and X Manager run data.

#### 2.4 Browser Tools

Browser automation is provided via MCP:

| Tool | Description |
|------|-------------|
| `browser_navigate` | Navigate to a URL. |
| `browser_click` | Click an element. |
| `browser_type` | Type text into an element. |
| `browser_screenshot` | Take a screenshot of the current page. |
| `browser_scroll` | Scroll the page. |
| `browser_close_all` | Close all browser windows. |

- Browser tools operate on a shared browser instance within a single skill execution.
- The `retry_with_browser_use_agent` tool MUST be excluded from tool sets to maintain authenticated sessions.

#### 2.5 Finish Tool

| Tool | Description |
|------|-------------|
| `finish` | Signal completion. Accepts `message` (string) and `nextCheckInTime` (minutes). |

- The agent MUST call `finish` at the end of every execution.
- `nextCheckInTime` is used to schedule the next agent-initiated check-in.

### 3. Skills

Skills are multi-step processes with embedded procedural guidance. Unlike tools, skills encode *how* to accomplish a complex workflow. Skills are invoked by the agent when the situation calls for them (not directly by the user).

#### 3.1 Check-In Skill

**Trigger**: Scheduled check-in or user requests a status review.

**Process**:
1. Fetch today's calendar events via `get_today_events`.
2. Fetch all accessible Notion pages as baseline context.
3. Read the user's daily task file for today (`tasks/YYYY-MM/D_dayname.txt`).
4. Read memory files (`memory/user.txt`, `memory/organization.txt`) to personalize.
5. Review calendar for upcoming deadlines, conflicts, or gaps.
6. Ask the user for updates on pending tasks.
7. Probe for blockers, uncertainties, or issues preventing progress.
8. Record any task updates or notes to the daily file.
9. Update memory files if new observations about the user emerge (with timestamps).
10. Determine next check-in time based on user's schedule and workload.
11. Call `finish` with the response and `nextCheckInTime`.

**Scheduling guidance**:
- No more than one check-in every few hours.
- No fewer than one check-in per work day.
- Adjust based on user's stated preferences, meeting density, and task urgency.

#### 3.2 X Feed Scan Skill

**Trigger**: Agent determines it's time to scan X feeds (as part of an X Manager run).

**Process**:
1. Navigate to `https://twitter.com`.
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
7. Call `finish` when done.

#### 3.3 X Metrics Check Skill

**Trigger**: Agent determines it's time to check X post metrics (as part of an X Manager run).

**Process**:
1. Navigate to `https://twitter.com/{xUsername}` (user's profile).
2. Identify posts from the last 24 hours (configurable).
3. Click into each recent post to view full metrics.
4. For each post, append a JSONL line to the run record file:
   ```json
   {"type":"metric","postLink":"...","postText":"...","impressions":0,"likes":0,"replies":0,"retweets":0,"engagementRate":0.0}
   ```
5. If no recent posts exist, finish without writing anything.
6. Call `finish` when done.

#### 3.4 X Manager Orchestration Skill

**Trigger**: Scheduled X Manager run or user requests an X scan.

**Process**:
1. Read configuration files from workspace: `config/areas_of_interest.md`, `config/engagement_criteria.md`.
2. Read insight files: `insights/reply_strategy.txt`, `insights/performance_log.txt`.
3. Retrieve last run state from Redis (timestamp, summary).
4. Create a timestamped run record file: `runs/YYYY-MM/D_dayname/run-record-TIMESTAMP.jsonl`.
5. Initialize a shared browser instance.
6. Execute sequentially:
   a. **Feed Scan** (skill 3.2)
   b. **Metrics Check** (skill 3.3)
7. Read the completed run record file and parse JSONL entries.
8. Generate a Slack-formatted digest message with sections:
   - Engagement Opportunities (with reasons and links)
   - Recent Post Performance (with metrics)
9. Update insight files based on run results.
10. Store run state in Redis (timestamp, summary).
11. Schedule the next X Manager run (production only).
12. Close the shared browser instance.
13. Return the Slack message and run record.

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
3. The system MUST build context from calendar events, Notion pages, and conversation history.
4. The agent MUST execute with the context and call `finish` to return a response and next check-in time.
5. The system MUST schedule the next check-in based on the agent's recommendation.
6. The system MUST produce a complete execution trace.

#### 5.2 X Manager Run
1. The system MUST validate that an X username is configured before proceeding.
2. The system MUST reject the request if an active X Manager run exists for the user.
3. The system MUST acquire a run lock before execution and release it after completion (including on failure).
4. The system MUST load configuration (areas of interest, engagement criteria, insights, last run state) before executing skills.
5. The system MUST execute the X Manager orchestration skill (§3.4).
6. The system MUST produce a complete execution trace.
7. The system MUST return a Slack-formatted digest and the run record.

## Edge Cases

- **No calendar events today**: The check-in skill MUST still execute and provide value from other context sources (Notion, tasks, memory).
- **Notion unavailable**: If Notion tools fail to initialize, the agent MUST proceed with remaining tools. Notion is not required for execution.
- **Browser fails to launch**: If browser tools fail to initialize during an X Manager run, the run MUST fail with a clear error — browser is required for feed scanning and metrics checking.
- **Empty run record**: If a feed scan or metrics check produces no results, the X Manager orchestration MUST still generate a Slack digest noting that no opportunities or metrics were found.
- **Concurrent run attempt**: If a run is attempted while another is active for the same user, the system MUST reject with an error (not queue or wait).
- **Agent reaches max steps without calling finish**: The execution MUST be treated as a failure.
- **MCP client connection failure**: If a workspace or browser MCP client fails to connect, the system MUST report the error and not silently proceed with missing tools.
- **Stale Redis lock**: If a run lock exists but no execution is active (e.g., after a crash), the system SHOULD provide a mechanism to clear stale locks.

## NOT Specified (Implementation Freedom)

- **Model selection logic**: Which specific LLM model to use for which task. The spec requires OpenRouter support and user configurability but does not prescribe model-to-task mapping.
- **Prompt wording**: Exact phrasing of system prompts and tool descriptions. The spec defines behavior, not prose.
- **Langfuse prompt versioning**: How prompts are versioned or promoted in Langfuse.
- **Insight file update algorithm**: How run results are analyzed to update `reply_strategy.txt` and `performance_log.txt`. Currently stubbed.
- **Slack message formatting details**: Exact Slack markdown/mrkdwn formatting beyond the required sections.
- **Error recovery strategies**: How the agent recovers from partial failures (e.g., one sub-skill fails during X Manager orchestration). Currently errors are caught and logged, execution continues.
- **Memory file pruning heuristics**: When and how to trim old entries from memory files.
- **Browser page-loading timeouts and retry logic**: How long to wait for pages, when to retry navigation.
- **Feed pagination strategy**: Exact scroll behavior, wait times between pages, detection of "no more content."
- **UI/Frontend**: The spec covers the backend agent system only. Any dashboard, settings UI, or chat interface is out of scope.

## Invariants

1. **Single active run**: At most one agent execution (check-in OR conversation) may be active per user at any time. Enforced via Redis locks.
2. **Single active X Manager run**: At most one X Manager run may be active per user at any time. Independent from the check-in lock.
3. **Finish tool required**: Every agent execution MUST end with a `finish` tool call. If the agent reaches max steps without calling `finish`, the execution is treated as a failure.
4. **Run record immutability**: Once a run record JSONL file is written and finalized, it MUST NOT be modified. New runs create new files.
5. **Authenticated browser sessions**: Browser tools MUST operate within a pre-authenticated session. The agent MUST NOT attempt to log into X programmatically — login is a separate, user-initiated flow.
6. **Timestamp consistency**: All timestamps in run records, file names, and scheduling MUST use ISO 8601 format. Display times for the user use PST.
7. **Workspace isolation**: Each user's workspace is scoped. One user's agent MUST NOT access another user's workspace files.
8. **Trace completeness**: Every agent execution MUST produce a Langfuse trace with session ID, step-level spans, and tool call metadata.
9. **Graceful cleanup**: Browser instances and MCP clients MUST be closed in `finally` blocks regardless of execution outcome.
10. **Sequential X Manager sub-skills**: Feed scan and metrics check MUST execute sequentially (not in parallel) because they share a single browser instance.

## Implementation Hints

- **Google Calendar**: OAuth 2.0 with stored credentials in database. Automatic token refresh on expiry. Primary calendar only.
- **Notion**: Dual auth support — internal integration token OR OAuth. MCP-based tool access (local stdio server or hosted SSE).
- **Browser automation**: browser-use MCP client (local stdio or cloud). Profile-based sessions for persistent login state.
- **Filesystem**: Constellation MCP backend for workspace operations. Scoped per user and workspace name.
- **Redis**: Used for active run tracking, check-in scheduling, and X Manager run state.
- **Langfuse**: System prompt management (fetch by name with fallbacks), execution tracing and telemetry.
- **LLM Provider**: OpenRouter for model routing. Supported models: Gemini, GPT, Claude (configurable per user). Reasoning/extended thinking where available.
- **Workspace directory structure**:
  ```
  workspace/
  ├── tasks/YYYY-MM/D_dayname.txt
  ├── memory/{organization,user,notes}.txt
  └── xmanager/{config,insights,runs}/...
  ```
