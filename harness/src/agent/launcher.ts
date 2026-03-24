/**
 * Agent Launcher
 *
 * The core function of the harness. Loads an agent config, resolves its
 * persona, capabilities, and resolvers, then delegates execution to the runtime.
 *
 * If the agent has .claude/skills/, symlinks them into the workspace so
 * Claude Code discovers them natively.
 *
 * No scheduling, no messaging, no persistence — those are the caller's job.
 */

import { readFile, mkdir, symlink, lstat } from "fs/promises";
import { resolve } from "path";
import type { AgentRuntime } from "../runtime/types.js";
import { resolveCapabilities } from "../capability/mcp-resolver.js";
import { runResolvers } from "../resolver/runner.js";
import type { AgentConfig, AgentInput, AgentResult } from "./types.js";

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;
const DEFAULT_MAX_TURNS = 20;

export interface LauncherConfig {
  /** Directory containing agent subdirectories. */
  agentsDir: string;
  /** Directory containing capability JSON files. */
  capabilitiesDir: string;
  /** Directory containing resolver definitions and modules. */
  resolversDir?: string;
  /** Root directory for agent workspaces. Defaults to <cwd>/workspace. */
  workspaceRoot?: string;
}

/**
 * Load and parse an agent.json config file.
 */
async function loadAgentConfig(
  agentsDir: string,
  agentId: string
): Promise<{ config: AgentConfig; agentDir: string }> {
  const agentDir = resolve(agentsDir, agentId);
  const configPath = resolve(agentDir, "agent.json");
  const content = await readFile(configPath, "utf-8");
  const config = JSON.parse(content) as AgentConfig;
  return { config, agentDir };
}

/**
 * Load and interpolate the persona template.
 */
async function loadPersona(
  personaRef: string,
  agentDir: string,
  context: Record<string, string>
): Promise<string> {
  let template: string;

  if (personaRef.startsWith("./") || personaRef.endsWith(".md")) {
    const personaPath = resolve(agentDir, personaRef);
    template = await readFile(personaPath, "utf-8");
  } else {
    template = personaRef;
  }

  return template.replace(TEMPLATE_VAR_PATTERN, (match, key) => {
    return context[key] ?? match;
  });
}

/**
 * Ensure .claude/skills/ is symlinked from the agent definition into the workspace
 * so Claude Code discovers skills natively.
 */
async function ensureSkillsSymlink(
  agentDir: string,
  workingDirectory: string
): Promise<void> {
  const agentSkillsDir = resolve(agentDir, ".claude", "skills");
  const workspaceSkillsDir = resolve(workingDirectory, ".claude", "skills");

  // Check if agent has skills
  try {
    await lstat(agentSkillsDir);
  } catch {
    return; // No skills directory in agent definition
  }

  // Check if symlink already exists
  try {
    const stat = await lstat(workspaceSkillsDir);
    if (stat.isSymbolicLink()) return; // Already symlinked
  } catch {
    // Doesn't exist yet — create it
  }

  await mkdir(resolve(workingDirectory, ".claude"), { recursive: true });
  await symlink(agentSkillsDir, workspaceSkillsDir);
}

/**
 * Create an agent launcher bound to specific directories and a runtime.
 */
export function createLauncher(runtime: AgentRuntime, config: LauncherConfig) {
  const {
    agentsDir,
    capabilitiesDir,
    resolversDir,
    workspaceRoot = resolve(process.cwd(), "workspace"),
  } = config;

  /**
   * Launch an agent execution.
   */
  async function launch(input: AgentInput): Promise<AgentResult> {
    // 1. Load agent config
    const { config: agent, agentDir } = await loadAgentConfig(
      agentsDir,
      input.agentId
    );

    // 2. Determine working directory and ensure it exists
    const workingDirectory =
      input.workingDirectory ??
      resolve(workspaceRoot, agent.id);
    await mkdir(workingDirectory, { recursive: true });

    // 3. Symlink skills from agent definition into workspace
    await ensureSkillsSymlink(agentDir, workingDirectory);

    // 4. Run resolvers (pre-run data fetching, skipped on session resume)
    let resolverContext: Record<string, string> = {};
    if (agent.resolvers?.length && resolversDir && !input.sessionId) {
      const harnessRoot = resolve(resolversDir, "..");
      resolverContext = await runResolvers(agent.resolvers, resolversDir, {
        workingDirectory,
        harnessRoot,
      });
    }

    // Merge: resolver output is base, caller context overrides
    const mergedContext = { ...resolverContext, ...(input.context ?? {}) };

    // 5. Load and interpolate persona
    const persona = await loadPersona(
      agent.persona,
      agentDir,
      mergedContext
    );

    // 6. Resolve MCP capabilities
    const resolved = agent.capabilities.length > 0
      ? await resolveCapabilities(agent.capabilities, capabilitiesDir)
      : undefined;

    const mcpServers = resolved && Object.keys(resolved.servers).length > 0
      ? resolved.servers
      : undefined;

    const enableChrome = agent.enableChrome || (resolved?.flags.includes("chrome") ?? false);

    // 7. Build full prompt: persona + user prompt
    const fullPrompt = input.sessionId
      ? input.prompt
      : `${persona}\n\n---\n\n${input.prompt}`;

    // 8. Execute via runtime
    const result = await runtime.execute({
      prompt: fullPrompt,
      outputSchema: agent.outputSchema,
      maxTurns: agent.maxTurns ?? DEFAULT_MAX_TURNS,
      workingDirectory,
      sessionId: input.sessionId,
      mcpServers,
      enableChrome,
    });

    return {
      success: !result.error,
      output: result.output,
      rawText: result.rawText,
      sessionId: result.sessionId,
      error: result.error,
    };
  }

  return { launch };
}
