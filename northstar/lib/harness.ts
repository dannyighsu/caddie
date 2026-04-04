/**
 * Harness Integration
 *
 * Creates and caches the runtime + launcher from @agints/harness.
 * All API routes use getLauncher() to access the shared instance.
 */

import { resolve } from "path";
import { createRuntime, createLauncher } from "@agints/harness";
import type { AgentConfig } from "@agints/harness";
import { readdir, readFile } from "fs/promises";

// The harness package lives alongside northstar in the monorepo
const repoRoot = resolve(process.cwd(), "..");
const harnessRoot = resolve(repoRoot, "harness");

export const workspaceRoot = process.env.WORKSPACE_ROOT
  ? resolve(process.env.WORKSPACE_ROOT)
  : resolve(repoRoot, "workspace");

export const resolversDir = resolve(harnessRoot, "resolvers");

let launcherInstance: ReturnType<typeof createLauncher> | null = null;

export function getLauncher() {
  if (!launcherInstance) {
    const runtime = createRuntime();
    const workspaceRoot = process.env.WORKSPACE_ROOT
      ? resolve(process.env.WORKSPACE_ROOT)
      : resolve(repoRoot, "workspace");

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
