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

import { readFile, mkdir, symlink, lstat, readdir, copyFile } from "fs/promises";
import { resolve } from "path";
import type { AgentRuntime } from "../runtime/types.js";
import { resolveCapabilities } from "../capability/mcp-resolver.js";
import { runResolvers } from "../resolver/runner.js";
import type { AgentConfig, AgentInput, AgentResult } from "./types.js";

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;
const DEFAULT_MAX_TURNS = 100;

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
 * Ensure harness-level .claude/settings.json (hooks, etc.) is symlinked into the workspace.
 */
async function ensureHarnessClaudeConfig(
  harnessRoot: string,
  workingDirectory: string
): Promise<void> {
  const harnessSettingsFile = resolve(harnessRoot, ".claude", "settings.json");
  const workspaceSettingsFile = resolve(workingDirectory, ".claude", "settings.json");

  try {
    await lstat(harnessSettingsFile);
  } catch {
    return; // No harness settings
  }

  try {
    const stat = await lstat(workspaceSettingsFile);
    if (stat.isSymbolicLink()) return; // Already symlinked
  } catch {
    // Doesn't exist yet
  }

  await mkdir(resolve(workingDirectory, ".claude"), { recursive: true });
  await symlink(harnessSettingsFile, workspaceSettingsFile);
}

/**
 * Copy seed config files from the agent definition into the workspace.
 * Only copies files that don't already exist — never overwrites user edits.
 */
async function bootstrapConfig(
  agentDir: string,
  workingDirectory: string
): Promise<void> {
  const seedDir = resolve(agentDir, "config");
  try {
    await lstat(seedDir);
  } catch {
    return; // No seed config in agent definition
  }

  const destDir = resolve(workingDirectory, "config");
  await mkdir(destDir, { recursive: true });

  const entries = await readdir(seedDir);
  for (const entry of entries) {
    const dest = resolve(destDir, entry);
    try {
      await lstat(dest);
      // Already exists — don't overwrite
    } catch {
      await copyFile(resolve(seedDir, entry), dest);
    }
  }
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
    // 1. Load agent config and apply profile overrides
    const { config: baseAgent, agentDir } = await loadAgentConfig(
      agentsDir,
      input.agentId
    );

    const profile = input.profile ? baseAgent.profiles?.[input.profile] : undefined;
    const agent = {
      ...baseAgent,
      capabilities: profile?.capabilities ?? baseAgent.capabilities,
      resolvers: profile?.resolvers ?? baseAgent.resolvers,
      maxTurns: profile?.maxTurns ?? baseAgent.maxTurns,
      enableChrome: profile?.enableChrome ?? baseAgent.enableChrome,
      configFiles: { ...baseAgent.configFiles, ...profile?.configFiles },
    };

    // 2. Determine working directory and ensure it exists
    const workingDirectory = resolve(workspaceRoot, agent.id);
    await mkdir(workingDirectory, { recursive: true });

    // 3. Bootstrap config (seed files, never overwrites existing)
    await bootstrapConfig(agentDir, workingDirectory);

    // 4. Symlink skills and hooks into workspace
    await ensureSkillsSymlink(agentDir, workingDirectory);
    const harnessRoot = resolve(agentsDir, "..");
    await ensureHarnessClaudeConfig(harnessRoot, workingDirectory);

    // 4. Run resolvers (pre-run data fetching, skipped on session resume)
    let resolverContext: Record<string, string> = {};
    if (agent.resolvers?.length && resolversDir && !input.sessionId) {
      const harnessRoot = resolve(resolversDir, "..");
      resolverContext = await runResolvers(agent.resolvers, resolversDir, {
        workingDirectory,
        harnessRoot,
      });
    }

    // 4b. Load and interpolate persona (only resolver context goes here)
    const personaContext = { ...resolverContext, ...(input.context ?? {}) };
    const persona = await loadPersona(
      agent.persona,
      agentDir,
      personaContext
    );

    // 4c. Build run context preamble (appended to user message, not persona)
    const contextLines: string[] = [];

    // Generated per-run values
    const now = new Date();
    const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const year = pst.getFullYear();
    const month = String(pst.getMonth() + 1).padStart(2, "0");
    const day = String(pst.getDate());
    const dayName = pst.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    const ts = now.toISOString().replace(/:/g, "-").replace(/\..+/, "");
    contextLines.push(`Run record path: runs/${year}-${month}/${day}_${dayName}/run-record-${ts}.jsonl`);

    // Universal config: preferences
    try {
      const preferencesPath = resolve(workingDirectory, "config", "preferences.md");
      const preferences = (await readFile(preferencesPath, "utf-8")).trim();
      if (preferences) contextLines.push(`User preferences:\n${preferences}`);
    } catch {
      // preferences.md doesn't exist yet
    }

    // Profile/agent config files
    if (agent.configFiles) {
      for (const [key, relPath] of Object.entries(agent.configFiles)) {
        try {
          const fullPath = resolve(workingDirectory, relPath);
          const value = (await readFile(fullPath, "utf-8")).trim();
          if (value) contextLines.push(`${key}: ${value}`);
        } catch {
          // Config file doesn't exist — skip
        }
      }
    }

    // 6. Resolve MCP capabilities
    const resolved = agent.capabilities.length > 0
      ? await resolveCapabilities(agent.capabilities, capabilitiesDir)
      : undefined;

    const mcpServers = resolved && Object.keys(resolved.servers).length > 0
      ? resolved.servers
      : undefined;

    const enableChrome = agent.enableChrome || (resolved?.flags.includes("chrome") ?? false);

    // 7. Build full prompt: persona + context preamble + user prompt
    const contextPreamble = contextLines.length > 0 ? contextLines.join("\n\n") + "\n\n---\n\n" : "";
    const fullPrompt = input.sessionId
      ? input.prompt
      : `${persona}\n\n---\n\n${contextPreamble}${input.prompt}`;

    // 8. Execute via runtime
    const result = await runtime.execute({
      prompt: fullPrompt,
      outputSchema: agent.outputSchema,
      maxTurns: agent.maxTurns ?? DEFAULT_MAX_TURNS,
      workingDirectory,
      sessionId: input.sessionId,
      mcpServers,
      enableChrome,
      additionalEnv: input.additionalEnv,
    });

    return {
      success: !result.error,
      output: result.output,
      rawText: result.rawText,
      sessionId: result.sessionId,
      error: result.error,
      usage: result.usage,
    };
  }

  return { launch };
}
