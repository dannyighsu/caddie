#!/usr/bin/env node

/**
 * Introspect MCP Server
 *
 * Lets the agent look at its OWN execution traces so it can self-diagnose — list
 * recent runs (with their times, status, token cost, and errors) and read the
 * step-by-step transcript of any one of them.
 *
 * This is the sanctioned way for the agent to reach its traces: the transcripts
 * live outside the workspace (~/.claude/projects/...) and the run ledger lives in
 * Postgres, both off-limits to the agent's own file/DB access per its workspace
 * boundaries. So instead of reading either directly, this proxies through the
 * Northstar server, which already owns both:
 *   - list_runs → GET /api/runs        (the job_runs ledger — the "list of traces")
 *   - view_run  → GET /api/transcripts/<sessionId>  (one run's actual steps)
 *
 * The actual Claude Code runs — the transcripts on disk, one per session — are
 * the source of truth for what the agent did during a run. So `list_runs`
 * enumerates THOSE (via /api/transcripts) and merely enriches each with the
 * ledger's orchestration metadata (status, error, token cost, what triggered it)
 * when a matching row exists. They join on sessionId.
 *
 * Read-only and self-scoped — it can only ever see this agent's own runs, so it
 * exposes nothing new and is safe wherever the agent already runs.
 *
 * Env:
 *   NORTHSTAR_URL       — Base URL for the Northstar API (default: http://localhost:3000)
 *   NORTHSTAR_AGENT_ID  — Which agent's traces to read (default: "buri")
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const NORTHSTAR_URL = process.env.NORTHSTAR_URL || "http://localhost:3000";
const AGENT_ID = process.env.NORTHSTAR_AGENT_ID || "buri";

const server = new Server(
  { name: "introspect", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// --- Tool definitions ---

const tools = [
  {
    name: "list_runs",
    description:
      "List your own recent runs — the actual Claude Code sessions you executed, most recent first. Each is a real run that captured what you did, and each has a `sessionId` you pass to `view_run` to read its full transcript. " +
      "Use this to self-diagnose: see what ran when (run time and duration), and — for runs that went through the orchestrator — whether they succeeded or failed, why they failed, what triggered them (inbound message, scheduled job, trigger, or portal), and their token cost. " +
      "Runs carry this extra status/error/cost detail only while their ledger row is retained (~7 days); older runs still list from their transcript on disk, just with less metadata. " +
      "Defaults to all runs; filter to 'failed' to focus on ones to debug, or 'active' for runs in flight.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["all", "failed", "active"],
          description: "Which runs to list. 'all' (default). 'failed'/'active' filter by orchestrator status and so only include runs that still have a ledger row.",
        },
        limit: {
          type: "number",
          description: "Max number of runs to return, most recent first. Default 20, max 200.",
        },
      },
    },
  },
  {
    name: "view_run",
    description:
      "Read the full step-by-step transcript of one of your runs — every assistant message, thinking block, tool call, and tool result, in order. " +
      "This is how you inspect what actually happened inside a run to debug it. " +
      "Get the `sessionId` from `list_runs` (it's the `session_id` field on a run). " +
      "For a long run, use `tail` to get just the last N steps — failures and their causes almost always live at the end.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "The session id of the run to view (the `session_id` from a `list_runs` entry).",
        },
        tail: {
          type: "number",
          description: "If set, return only the last N steps of the transcript (best for diagnosing a failure). Omit to return the whole run.",
        },
        search: {
          type: "string",
          description: "If set, return only steps whose content contains this substring (case-insensitive). Useful for finding where a specific tool or error appears.",
        },
      },
      required: ["sessionId"],
    },
  },
];

// --- Helpers ---

/** ms between two ISO timestamps, formatted human-friendly (e.g. "1m 12s"). */
function formatDuration(startIso, endIso) {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const secs = Math.round((end - start) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem}s` : `${mins}m`;
}

function truncate(text, max) {
  if (typeof text !== "string") return text;
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/** GET a JSON endpoint, returning null on any failure rather than throwing. */
async function fetchJsonSafe(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// --- Tool handlers ---

async function handleListRuns(args) {
  const status = ["all", "failed", "active"].includes(args.status) ? args.status : "all";
  const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 200);

  // Source of truth = the actual Claude Code run transcripts on disk (one per
  // session). The ledger is fetched only to enrich each with orchestration
  // metadata; both calls are best-effort so a failure of one still yields a list.
  const [transcripts, ledger] = await Promise.all([
    fetchJsonSafe(`${NORTHSTAR_URL}/api/transcripts?agentId=${encodeURIComponent(AGENT_ID)}`),
    fetchJsonSafe(`${NORTHSTAR_URL}/api/runs?agentId=${encodeURIComponent(AGENT_ID)}&status=all&limit=200`),
  ]);

  // Index ledger rows by session_id, keeping the most recent (the list is
  // already created_at-desc, so the first row seen for a session wins).
  const ledgerBySession = new Map();
  if (Array.isArray(ledger)) {
    for (const r of ledger) {
      if (r.session_id && !ledgerBySession.has(r.session_id)) ledgerBySession.set(r.session_id, r);
    }
  }

  const enrich = (sessionId, ranAt, sizeBytes, run) => ({
    sessionId,
    ranAt,
    ...(sizeBytes != null ? { sizeKB: Math.round(sizeBytes / 1024) } : {}),
    ...(run
      ? {
          status: run.status,
          source: run.source,
          label: run.label ?? undefined,
          duration: formatDuration(run.created_at, run.updated_at) ?? undefined,
          failure: run.failure_class ?? undefined,
          error: run.error ? truncate(run.error, 300) : undefined,
          tokens: run.tokens ?? undefined,
          replayOf: run.replay_of ?? undefined,
        }
      : {}),
  });

  let runs;
  let basis;
  if (Array.isArray(transcripts) && transcripts.length > 0) {
    // Preferred path: enumerate real run transcripts, enrich from the ledger.
    basis = "transcripts on disk";
    runs = transcripts.map((t) =>
      enrich(t.sessionId, t.modified, t.size, ledgerBySession.get(t.sessionId))
    );
  } else if (Array.isArray(ledger)) {
    // Fallback: transcript listing unavailable — list from the ledger instead.
    basis = "job-run ledger (transcript listing unavailable)";
    const seen = new Set();
    runs = [];
    for (const r of ledger) {
      const key = r.session_id ?? r.id;
      if (seen.has(key)) continue;
      seen.add(key);
      runs.push(enrich(r.session_id ?? undefined, r.updated_at, null, r));
    }
  } else {
    return {
      content: [{ type: "text", text: "Could not reach the run APIs to list runs. Is the Northstar server up?" }],
      isError: true,
    };
  }

  // status filter applies to orchestrator status, so it needs a ledger row.
  if (status === "failed") runs = runs.filter((r) => r.status === "failed");
  else if (status === "active") runs = runs.filter((r) => r.status === "running");

  runs = runs.slice(0, limit);

  if (runs.length === 0) {
    return { content: [{ type: "text", text: `No ${status === "all" ? "" : status + " "}runs found.` }] };
  }

  const enriched = runs.filter((r) => r.status).length;
  const header =
    `${runs.length} run(s) from ${basis}, most recent first. ` +
    `${enriched}/${runs.length} have orchestrator status/error/cost detail; ` +
    `pass any run's sessionId to view_run to read its full transcript.`;

  return {
    content: [{ type: "text", text: `${header}\n\n${JSON.stringify(runs, null, 2)}` }],
  };
}

async function handleViewRun(args) {
  const { sessionId } = args;
  if (!sessionId) {
    return { content: [{ type: "text", text: "view_run requires a `sessionId`." }], isError: true };
  }

  const url = `${NORTHSTAR_URL}/api/transcripts/${encodeURIComponent(sessionId)}?agentId=${encodeURIComponent(AGENT_ID)}`;
  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok || !Array.isArray(data?.steps)) {
    return {
      content: [
        {
          type: "text",
          text:
            `Could not read transcript for session ${sessionId}: ${data?.error ?? res.statusText}. ` +
            `Confirm the sessionId from list_runs — a run that never got off the ground may have no transcript.`,
        },
      ],
      isError: true,
    };
  }

  let steps = data.steps;
  const total = steps.length;

  if (args.search) {
    const needle = String(args.search).toLowerCase();
    steps = steps.filter((s) => typeof s.content === "string" && s.content.toLowerCase().includes(needle));
  }

  let note = "";
  if (Number.isFinite(Number(args.tail)) && Number(args.tail) > 0) {
    const n = Number(args.tail);
    if (steps.length > n) {
      note = ` (showing last ${n} of ${steps.length}${args.search ? " matching" : ""})`;
      steps = steps.slice(-n);
    }
  }

  const rendered = steps
    .map((s, i) => {
      const idx = String(i + 1).padStart(3, " ");
      const tag = `[${s.role}/${s.type}${s.toolName ? `:${s.toolName}` : ""}]`;
      return `${idx} ${tag} ${s.content}`;
    })
    .join("\n\n");

  const header =
    `Transcript for session ${sessionId} — ${total} step(s) total` +
    `${args.search ? `, ${steps.length} matching "${args.search}"` : ""}${note}.`;

  return {
    content: [{ type: "text", text: `${header}\n\n${rendered || "(no steps to show)"}` }],
  };
}

const handlers = {
  list_runs: handleListRuns,
  view_run: handleViewRun,
};

// --- MCP wiring ---

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const handler = handlers[name];

  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }

  try {
    return await handler(args ?? {});
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
