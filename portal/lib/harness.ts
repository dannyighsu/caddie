/**
 * Harness Integration
 *
 * Creates and caches the runtime + launcher from @ignis/harness.
 * All API routes use getLauncher() to access the shared instance.
 */

import { resolve } from "path";
import { createRuntime, createLauncher, workspaceDir } from "@ignis/harness";
import type { AgentConfig, AgentInput, AgentResult } from "@ignis/harness";
import { mkdir, readFile } from "fs/promises";
import { alertOwnerOnApiFailure } from "./run-alerts";
import { teamRoster } from "./team";

// The harness package lives alongside the portal in the monorepo
const repoRoot = resolve(process.cwd(), "..");
const harnessRoot = resolve(repoRoot, "harness");

/** The agent's working directory. */
export const workspace = workspaceDir();

export const resolversDir = resolve(harnessRoot, "resolvers");
/** The agent definition: agent.json, SYSTEM.md, PERSONA.md, skills, seed config. */
export const agentDir = resolve(harnessRoot, "agent");
/** Shared, instance-agnostic skills mounted for the agent. */
export const coreSkillsDir = resolve(harnessRoot, "skills", "core");

/** The agent's agent.json. */
export async function getAgentConfig(): Promise<AgentConfig> {
  const content = await readFile(resolve(agentDir, "agent.json"), "utf-8");
  return JSON.parse(content) as AgentConfig;
}

/**
 * Create (if needed) and return today's run-artifacts directory, scoped by
 * `scope` — e.g. `telegram-<chatId>`, `email-<threadId>`. Inbound attachments
 * land here, kept apart from the agent's own artifacts (feed-scan snapshots and
 * the like) and from each other's conversations.
 *
 * Dated in PST, matching the rest of the run tree.
 */
export async function runArtifactsDir(scope: string): Promise<string> {
  const now = new Date();
  const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const year = pst.getFullYear();
  const month = String(pst.getMonth() + 1).padStart(2, "0");
  const day = String(pst.getDate());
  const dayName = pst.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();

  const dir = resolve(
    workspace,
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
    // Expose harness root for MCP capability env var resolution
    process.env.HARNESS_ROOT = harnessRoot;

    launcherInstance = createLauncher(runtime, {
      agentDir,
      capabilitiesDir: resolve(harnessRoot, "capabilities"),
      resolversDir,
      workspace,
      team: teamRoster,
    });
  }
  return launcherInstance;
}

/**
 * The shared launcher, wrapped so that every launch site — inbound channel
 * messages, the console run route, the control API, and the scheduler — routes
 * through one chokepoint that alerts the owner on any API-layer failure. Keeps
 * "detect a failed run and email the owner" in a single place instead of scattered
 * across callers where a new entry point could silently skip it.
 */
export function getLauncher() {
  const launcher = getRawLauncher();
  return {
    async launch(input: AgentInput): Promise<AgentResult> {
      try {
        const result = await launcher.launch(input);
        // Best-effort and no-op unless this was an API-layer failure.
        await alertOwnerOnApiFailure(result);
        return result;
      } finally {
        // Whatever the outcome, the run may have written files worth indexing.
        // Imported lazily: the indexer is optional and loads nothing until used.
        import("./workspace-index")
          .then((m) => m.requestIndexSync())
          .catch(() => {});
      }
    },
  };
}
