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
import { resolve, dirname } from "path";
import type { AgentRuntime } from "../runtime/types.js";
import { resolveCapabilities } from "../capability/mcp-resolver.js";
import {
  loadPermissions,
  isAllowed,
  filterCapabilitiesByPolicy,
  BASE_TOOLS_KEY,
} from "../policy/permissions.js";
import { runResolvers } from "../resolver/runner.js";
import type { AgentConfig, AgentInput, AgentResult } from "./types.js";

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;
const DEFAULT_MAX_TURNS = 150;

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
 * Symlink a read-only directory from the agent definition into the workspace at
 * the same relative path, so the running agent sees the agent's stable
 * definitions natively. Used for `.claude/skills/` (native skill discovery) and
 * `jobs/` (recurring-job procedures injected as "Job instructions"). A no-op if
 * the agent has no such directory or the workspace already links it — so an edit
 * to the agent definition propagates without a workspace rebuild.
 */
async function ensureDefinitionSymlink(
  agentDir: string,
  workingDirectory: string,
  relPath: string
): Promise<void> {
  const agentPath = resolve(agentDir, relPath);
  const workspacePath = resolve(workingDirectory, relPath);

  // Nothing to link if the agent definition doesn't have it.
  try {
    await lstat(agentPath);
  } catch {
    return;
  }

  // Already linked — leave it.
  try {
    const stat = await lstat(workspacePath);
    if (stat.isSymbolicLink()) return;
  } catch {
    // Doesn't exist yet — create it below.
  }

  await mkdir(dirname(workspacePath), { recursive: true });
  await symlink(agentPath, workspacePath);
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
  await copySeedTree(seedDir, resolve(workingDirectory, "config"));
}

/**
 * Recursively copy a seed directory into the workspace — creating subdirectories
 * and copying any file that doesn't already exist, never overwriting user edits.
 * Recursion lets seeds ship nested config (e.g. config/household/<member>.md).
 */
async function copySeedTree(srcDir: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = resolve(srcDir, entry.name);
    const dest = resolve(destDir, entry.name);
    if (entry.isDirectory()) {
      await copySeedTree(src, dest);
    } else {
      try {
        await lstat(dest);
        // Already exists — don't overwrite
      } catch {
        await copyFile(src, dest);
      }
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

    // 4. Symlink skills, job definitions, and hooks into workspace
    await ensureDefinitionSymlink(agentDir, workingDirectory, ".claude/skills");
    await ensureDefinitionSymlink(agentDir, workingDirectory, "jobs");
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

    // 4b. Load and interpolate persona. The persona is kept static (no per-run
    // values) so it stays a stable prefix for prompt caching — dynamic values
    // go in the run-context block below instead.
    const personaContext = { ...resolverContext, ...(input.context ?? {}) };
    const persona = await loadPersona(
      agent.persona,
      agentDir,
      personaContext
    );

    // 4c. Build run context preamble — placed AFTER the static persona and just
    // before the user message, so the volatile per-run values (identity, time,
    // paths) come last and don't bust the cacheable persona prefix.
    const contextLines: string[] = [
      `Origin channel: ${input.identity.originChannel}`,
      `Sender: ${input.identity.senderIdentity}`,
      `Trust tier: ${input.identity.trustTier}`,
    ];

    // Generated per-run values
    const now = new Date();
    const pst = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
    const year = pst.getFullYear();
    const month = String(pst.getMonth() + 1).padStart(2, "0");
    const day = String(pst.getDate());
    const dayName = pst.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
    const ts = now.toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const runDir = `runs/${year}-${month}/${day}_${dayName}`;
    contextLines.push(`Run record path: ${runDir}/run-record-${ts}.jsonl`);
    contextLines.push(`Artifacts directory: ${runDir}/artifacts/`);

    // Universal config: preferences
    try {
      const preferencesPath = resolve(workingDirectory, "config", "preferences.md");
      const preferences = (await readFile(preferencesPath, "utf-8")).trim();
      if (preferences) contextLines.push(`User preferences:\n${preferences}`);
    } catch {
      // preferences.md doesn't exist yet
    }

    // Per-job files, keyed by stateKey (the job's purpose) and sanitized so the
    // read can't escape the workspace. Injected on any run that carries a
    // stateKey (scheduled runs and manual job triggers); ad-hoc chat passes no
    // stateKey and gets nothing here. A recurring job has two files:
    //   jobs/<key>.md  — the stable procedure (the job's canonical definition,
    //                    replacing the old per-job skill). Injected first so the
    //                    run has its playbook without depending on a skill.
    //   state/<key>.md — agent-maintained state (dedup markers, pauses) and
    //                    expiring human directives that carry between runs.
    if (input.stateKey) {
      const safeKey = input.stateKey.replace(/[^a-z0-9._-]/gi, "");
      if (safeKey) {
        try {
          const jobsPath = resolve(workingDirectory, "jobs", `${safeKey}.md`);
          const jobInstructions = (await readFile(jobsPath, "utf-8")).trim();
          if (jobInstructions) {
            contextLines.push(`Job instructions (jobs/${safeKey}.md):\n${jobInstructions}`);
          }
        } catch {
          // No instructions file — an ad-hoc or not-yet-defined job.
        }
        try {
          const statePath = resolve(workingDirectory, "state", `${safeKey}.md`);
          const jobState = (await readFile(statePath, "utf-8")).trim();
          if (jobState) contextLines.push(`Job state (state/${safeKey}.md):\n${jobState}`);
        } catch {
          // No state file yet — the job creates it on first use.
        }
      }
    }

    // Household directory — the people Buri serves and how to reach them, built
    // from the same env vars that drive inbound email identity (DANNY_EMAIL /
    // BETTY_EMAIL), so the addresses the agent invites match the ones the auth
    // gate trusts. Each var is a comma-separated list; the first entry is the
    // primary address. Injected ONLY for household-tier runs — a guest run must
    // never receive these private addresses.
    if (input.identity.trustTier === "household") {
      const household: string[] = [];
      const addMember = (name: string, envValue: string | undefined): void => {
        const emails = (envValue ?? "").split(",").map((e) => e.trim()).filter(Boolean);
        if (emails.length === 0) return;
        const [primary, ...alts] = emails;
        const altNote = alts.length > 0 ? ` (also: ${alts.join(", ")})` : "";
        household.push(`- ${name}: ${primary}${altNote}`);
      };
      addMember("Danny", process.env.DANNY_EMAIL);
      addMember("Betty", process.env.BETTY_EMAIL);
      if (household.length > 0) {
        contextLines.push(
          `Household directory (the people you serve — to put an event on someone's ` +
            `calendar, invite their primary email as an attendee):\n${household.join("\n")}`
        );
      }

      // Per-member profiles and standing instructions (config/household/<member>.md).
      // These are private, so they're injected ONLY on household-tier runs —
      // never surfaced to a guest. Every *.md is read so new members are picked
      // up without code changes.
      try {
        const membersDir = resolve(workingDirectory, "config", "household");
        const memberFiles = (await readdir(membersDir))
          .filter((f) => f.endsWith(".md"))
          .sort();
        for (const file of memberFiles) {
          const content = (await readFile(resolve(membersDir, file), "utf-8")).trim();
          if (content) {
            contextLines.push(`Household member — ${file.replace(/\.md$/, "")}:\n${content}`);
          }
        }
      } catch {
        // No config/household/ directory yet
      }
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

    // 6. Apply the permission policy (harness/permissions.json) for this run's
    // trust tier — default-deny. Filter the agent's declared capabilities to the
    // granted ones, and decide whether built-in Claude Code tools are allowed.
    const trustTier = input.identity.trustTier;
    const permissions = await loadPermissions(harnessRoot);
    const trustFiltered = agent.capabilities.length > 0
      ? filterCapabilitiesByPolicy(agent.capabilities, permissions, trustTier)
      : { kept: [], dropped: [] };
    const baseToolsAllowed = isAllowed(permissions, trustTier, BASE_TOOLS_KEY);

    if (trustFiltered.dropped.length > 0) {
      console.log(
        `[Launcher] Trust tier "${trustTier}" dropped capabilities: ${trustFiltered.dropped.join(", ")}`
      );
    }
    if (!baseToolsAllowed) {
      console.log(`[Launcher] Trust tier "${trustTier}" — built-in tools disabled`);
    }

    const resolved = trustFiltered.kept.length > 0
      ? await resolveCapabilities(trustFiltered.kept, capabilitiesDir)
      : undefined;

    const mcpServers = resolved && Object.keys(resolved.servers).length > 0
      ? resolved.servers
      : undefined;

    const enableChrome = agent.enableChrome || (resolved?.flags.includes("chrome") ?? false);

    // 7. Build full prompt: persona + context preamble + user prompt
    // Always prepend a fresh timestamp so the agent has the current time
    // even on session resumes (where the persona is not re-rendered).
    const currentTime = input.context?.currentTime;
    const timeHeader = currentTime ? `[Current time: ${currentTime}]\n\n` : "";
    const userPrompt = `${timeHeader}${input.prompt}`;

    const contextPreamble = contextLines.length > 0 ? contextLines.join("\n\n") + "\n\n---\n\n" : "";
    const fullPrompt = input.sessionId
      ? userPrompt
      : `${persona}\n\n---\n\n${contextPreamble}${userPrompt}`;

    // 8. Execute via runtime
    const result = await runtime.execute({
      prompt: fullPrompt,
      outputSchema: agent.outputSchema,
      maxTurns: agent.maxTurns ?? DEFAULT_MAX_TURNS,
      workingDirectory,
      sessionId: input.sessionId,
      mcpServers,
      enableChrome,
      disableBuiltinTools: !baseToolsAllowed,
      harnessRoot,
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
