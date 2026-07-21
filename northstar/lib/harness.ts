/**
 * Harness Integration
 *
 * Creates and caches the runtime + launcher from @agints/harness.
 * All API routes use getLauncher() to access the shared instance.
 */

import { resolve } from "path";
import { createRuntime, createLauncher } from "@agints/harness";
import type { AgentConfig, AgentInput, AgentResult } from "@agints/harness";
import { readdir, readFile } from "fs/promises";
import { alertOwnerOnApiFailure } from "./run-alerts";

// The harness package lives alongside northstar in the monorepo
const repoRoot = resolve(process.cwd(), "..");
const harnessRoot = resolve(repoRoot, "harness");

export const workspaceRoot = process.env.WORKSPACE_ROOT
  ? resolve(process.env.WORKSPACE_ROOT)
  : resolve(repoRoot, "workspace");

export const resolversDir = resolve(harnessRoot, "resolvers");
export const agentsDir = resolve(harnessRoot, "agents");

let launcherInstance: ReturnType<typeof createLauncher> | null = null;

function getRawLauncher() {
  if (!launcherInstance) {
    const runtime = createRuntime({
      options: {
        model: process.env.CLAUDE_MODEL ?? "claude-sonnet-5",
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
