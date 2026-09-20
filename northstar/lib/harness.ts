/**
 * Harness Integration
 *
 * Creates and caches the runtime + launcher from @agints/harness.
 * All API routes use getLauncher() to access the shared instance.
 */

import { resolve } from "path";
import { createRuntime, createLauncher } from "@agints/harness";
import type { AgentConfig, AgentInput, AgentResult } from "@agints/harness";
import { mkdir, readdir, readFile } from "fs/promises";
import { alertOwnerOnApiFailure } from "./run-alerts";

// The harness package lives alongside northstar in the monorepo
const repoRoot = resolve(process.cwd(), "..");
const harnessRoot = resolve(repoRoot, "harness");

export const workspaceRoot = process.env.WORKSPACE_ROOT
  ? resolve(process.env.WORKSPACE_ROOT)
  : resolve(repoRoot, "workspace");

export const resolversDir = resolve(harnessRoot, "resolvers");
export const agentsDir = resolve(harnessRoot, "agents");
/** Shared, instance-agnostic skills mounted for every agent. */
export const coreSkillsDir = resolve(harnessRoot, "skills", "core");

/**
 * Create (if needed) and return today's run-artifacts directory for an agent,
 * scoped by `scope` — e.g. `telegram-<chatId>`, `email-<threadId>`. Inbound
 * attachments land here, kept apart from the agent's own artifacts (feed-scan
 * snapshots and the like) and from each other's conversations.
 *
 * Dated in PST, matching the rest of the run tree.
 */
export async function runArtifactsDir(agentId: string, scope: string): Promise<string> {
  const now = new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const year = pst.getFullYear();
  const month = String(pst.getMonth() + 1).padStart(2, "0");
  const day = String(pst.getDate());
  const dayName = pst.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

  const dir = resolve(
    workspaceRoot,
    agentId,
    "runs",
    `${year}-${month}`,
    `${day}_${dayName}`,
    "artifacts",
    scope,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

let launcherInstance: ReturnType<typeof createLauncher> | null = null;

function getRawLauncher() {
  if (!launcherInstance) {
    const runtime = createRuntime({
      options: {
        model: process.env.CLAUDE_MODEL ?? "claude-opus-5",
        effort: process.env.CLAUDE_EFFORT ?? "medium",
      },
    });
    const workspaceRoot = process.env.WORKSPACE_ROOT
      ? resolve(process.env.WORKSPACE_ROOT)
      : resolve(repoRoot, "workspace");

    // Expose harness root for MCP capability env var resolution
    process.env.HARNESS_ROOT = harnessRoot;

    launcherInstance = createLauncher(runtime, {
      agentsDir: resolve(harnessRoot, "agents"),
      capabilitiesDir: resolve(harnessRoot, "capabilities"),
      resolversDir: resolve(harnessRoot, "resolvers"),
      workspaceRoot,
    });
  }
  return launcherInstance;
}

/**
 * The shared launcher, wrapped so that every launch site — inbound channel
 * messages, the console run route, the control API, and the scheduler — routes
 * through one chokepoint that alerts the owner on any API-layer failure. Keeps
 * "detect a failed run and email danny" in a single place instead of scattered
 * across callers where a new entry point could silently skip it.
 */
export function getLauncher() {
  const launcher = getRawLauncher();
  return {
    async launch(input: AgentInput): Promise<AgentResult> {
      const result = await launcher.launch(input);
      // Best-effort and no-op unless this was an API-layer failure.
      await alertOwnerOnApiFailure(input.agentId, result);
      return result;
    },
  };
}

/**
 * The agent every un-attributed run belongs to — inbound messages, outbound
 * threads, failure alerts.
 *
 * This deployment runs one base agent; variation lives in its profiles, not in
 * separate agents. So the default is simply "the agent that's there", and an
 * explicit `DEFAULT_AGENT_ID` is only needed if a second one is ever added.
 * Throws rather than guessing when the choice is ambiguous.
 */
let cachedDefaultAgentId: string | null = null;

export async function defaultAgentId(): Promise<string> {
  if (cachedDefaultAgentId) return cachedDefaultAgentId;

  const configured = process.env.DEFAULT_AGENT_ID;
  if (configured) {
    cachedDefaultAgentId = configured;
    return configured;
  }

  const agents = await listAgents();
  if (agents.length === 1) {
    cachedDefaultAgentId = agents[0].id;
    return cachedDefaultAgentId;
  }
  if (agents.length === 0) {
    throw new Error(
      `No agents found in ${resolve(harnessRoot, "agents")}. Add one, or set DEFAULT_AGENT_ID.`
    );
  }
  throw new Error(
    `Multiple agents found (${agents.map((a) => a.id).join(", ")}) — set DEFAULT_AGENT_ID to pick the one that handles inbound messages.`
  );
}

/**
 * List all available agents by reading the harness/agents directory.
 */
export async function listAgents(): Promise<AgentConfig[]> {
  const agentsDir = resolve(harnessRoot, "agents");
  const entries = await readdir(agentsDir, { withFileTypes: true });
  const agents: AgentConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const configPath = resolve(agentsDir, entry.name, "agent.json");
      const content = await readFile(configPath, "utf-8");
      agents.push(JSON.parse(content) as AgentConfig);
    } catch {
      // Skip directories without a valid agent.json
    }
  }

  return agents;
}

/**
 * Get a single agent config by ID.
 */
export async function getAgent(id: string): Promise<AgentConfig | null> {
  const agentsDir = resolve(harnessRoot, "agents");
  try {
    const configPath = resolve(agentsDir, id, "agent.json");
    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content) as AgentConfig;
  } catch {
    return null;
  }
}
