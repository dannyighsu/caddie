/**
 * Agent Launcher
 *
 * The core function of the harness. Loads the agent config, resolves its
 * system prompt, capabilities, and resolvers, then delegates execution to the runtime.
 *
 * Mounts skills into the workspace so Claude Code discovers them natively —
 * shared core skills plus the agent's own, or just the ones a profile grants.
 *
 * No scheduling, no messaging, no persistence — those are the caller's job.
 */

import { readFile, mkdir, symlink, lstat, readdir, copyFile, unlink, rm, readlink } from "fs/promises";
import { resolve, dirname } from "path";
import { parseEnv } from "util";
import type { AgentRuntime } from "../runtime/types.js";
import { workspaceDir } from "../workspace.js";
import { resolveCapabilities } from "../capability/mcp-resolver.js";
import {
  loadPermissions,
  isAllowed,
  filterCapabilitiesByPolicy,
  BASE_TOOLS_KEY,
} from "../policy/permissions.js";
import { runResolvers } from "../resolver/runner.js";
import type { TeamMember } from "../team/roster.js";
import {
  journalConfig,
  watchJournal,
  detectConfigDrift,
  describeConfigDrift,
  type ConfigDrift,
} from "./config-journal.js";
import type { AgentConfig, AgentProfile, AgentInput, AgentResult } from "./types.js";

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;
/** Turn ceiling for an agent that doesn't set one. Exported so UIs report the real number. */
export const DEFAULT_MAX_TURNS = 150;

export interface LauncherConfig {
  /** The agent definition: agent.json, SYSTEM.md, PERSONA.md, skills, seed config. */
  agentDir: string;
  /** Directory containing capability JSON files. */
  capabilitiesDir: string;
  /** Directory containing resolver definitions and modules. */
  resolversDir?: string;
  /** The agent's working directory. Defaults to `workspaceDir()`. */
  workspace?: string;
  /**
   * Directory of shared, instance-agnostic skills mounted on every run.
   * Defaults to <harnessRoot>/skills/core.
   */
  coreSkillsDir?: string;
  /**
   * The current team roster, read at the start of every run. The portal backs
   * this with its Postgres cache; smoke runs and evals pass a fixture. Defaults
   * to an empty team.
   */
  team?: () => TeamMember[];
}

async function loadAgentConfig(agentDir: string): Promise<AgentConfig> {
  const content = await readFile(resolve(agentDir, "agent.json"), "utf-8");
  return JSON.parse(content) as AgentConfig;
}

/**
 * The agent's own secrets: API tokens its jobs use, as `NAME=value` lines.
 * Not tracked (gitignored by `.env*`), and kept apart from the portal's
 * `.env.local` so the agent's environment holds only what's put here on
 * purpose. Read on every run, so a new token needs no restart.
 */
export const SECRETS_FILE = ".env";

async function loadAgentSecrets(agentDir: string): Promise<Record<string, string>> {
  try {
    const content = await readFile(resolve(agentDir, SECRETS_FILE), "utf-8");
    return parseEnv(content) as Record<string, string>;
  } catch {
    return {}; // No secrets file
  }
}

/** Who this install's agent is. Not tracked: each install writes its own. */
export const PERSONA_FILE = "PERSONA.md";
/** How the agent works, the same for every install. */
export const SYSTEM_FILE = "SYSTEM.md";

/**
 * The system prompt: the install's persona, then the shared system
 * instructions, with `{{var}}` interpolated. A missing persona fails the run
 * rather than launching an agent that doesn't know who it is or whom it serves.
 */
async function loadSystemPrompt(
  agentDir: string,
  context: Record<string, string>
): Promise<string> {
  let persona: string;
  try {
    persona = await readFile(resolve(agentDir, PERSONA_FILE), "utf-8");
  } catch {
    throw new Error(
      `No ${PERSONA_FILE} in ${agentDir}. Copy PERSONA.example.md to ${PERSONA_FILE} and fill it in.`
    );
  }
  const system = await readFile(resolve(agentDir, SYSTEM_FILE), "utf-8");
  return `${persona.trim()}\n\n${system.trim()}`.replace(TEMPLATE_VAR_PATTERN, (match, key) => {
    return context[key] ?? match;
  });
}

/**
 * Whether `link` is already a symlink to `target`. A symlink pointing anywhere
 * else — typically the repo's old path after it moved — is removed so the
 * caller recreates it; stopping at "it's a symlink" would leave it dangling.
 */
async function reuseOrClearLink(link: string, target: string): Promise<boolean> {
  const stat = await lstat(link).catch(() => null);
  if (!stat?.isSymbolicLink()) return false;
  if ((await readlink(link)) === target) return true;
  await unlink(link);
  return false;
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

  if (await reuseOrClearLink(workspaceSettingsFile, harnessSettingsFile)) return;

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
 * Recursion lets seeds ship nested config (e.g. config/team/<member>.md).
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
 * Capabilities for a run: the agent's base set, adjusted by the profile.
 *
 * Removals apply first, so a name in both lists ends up present. Adjusting
 * rather than replacing is deliberate — a profile that replaced the list could
 * drop a capability every run depends on without saying so.
 */
export function resolveProfileCapabilities(
  base: string[],
  profile?: AgentProfile
): string[] {
  if (!profile) return base;
  const result = new Set(base);
  for (const name of profile.removeCapabilities ?? []) result.delete(name);
  for (const name of profile.addCapabilities ?? []) result.add(name);
  return [...result];
}

/**
 * Mount skills into the workspace at `.claude/skills`, layering two sources:
 *
 *   1. `harness/skills/core/` — instance-agnostic mechanism (scheduling, skill
 *      authoring, repo mounting). Shared by every install, so a
 *      fix lands once instead of being copied into each agent directory.
 *   2. `<agentDir>/.claude/skills/` — this agent's own skills. On a name
 *      collision the agent's wins, so an install can override a core skill
 *      without editing the shared copy.
 *
 * The mount is a real directory of per-skill symlinks, rebuilt each run, with
 * entries a previous profile left behind swept away. Edits still propagate both
 * ways because each link points at the real skill directory.
 *
 * Because the mount is assembled rather than being one link to the agent
 * directory, a skill *created* under `.claude/skills/` would land in the
 * workspace and vanish on the next rebuild. So authoring goes through
 * `.claude/skills-src`, a link straight to the agent's own skills — see
 * ensureSkillsSrcLink and the `manage-skills` skill.
 */
async function mountSkills(
  agentDir: string,
  coreSkillsDir: string,
  workingDirectory: string,
  allowed?: string[]
): Promise<void> {
  const dest = resolve(workingDirectory, ".claude", "skills");

  // Collect name -> source directory. Core first, agent second so it overrides.
  const sources = new Map<string, string>();
  for (const dir of [coreSkillsDir, resolve(agentDir, ".claude", "skills")]) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // that source doesn't exist — fine
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".")) continue;
      sources.set(entry.name, resolve(dir, entry.name));
    }
  }

  if (allowed) {
    for (const name of allowed) {
      if (!sources.has(name)) {
        console.warn(`[Launcher] Profile grants unknown skill "${name}" — skipping`);
      }
    }
    for (const name of [...sources.keys()]) {
      if (!allowed.includes(name)) sources.delete(name);
    }
  }

  // An earlier version mounted the whole set as a single symlink at this path.
  // Unlink (never recursively remove) if that's what's there — recursing through
  // it would delete the agent's real skills.
  const current = await lstat(dest).catch(() => null);
  if (current?.isSymbolicLink()) await unlink(dest);
  await mkdir(dest, { recursive: true });

  // Drop links this run doesn't want (a previous profile's, or a deleted skill).
  for (const entry of await readdir(dest, { withFileTypes: true }).catch(() => [])) {
    if (sources.has(entry.name)) continue;
    const stale = resolve(dest, entry.name);
    if (entry.isSymbolicLink()) await unlink(stale);
    else await rm(stale, { recursive: true, force: true });
  }

  for (const [name, source] of sources) {
    const link = resolve(dest, name);
    const existing = await lstat(link).catch(() => null);
    if (existing) {
      // Repoint if it currently resolves somewhere else (core -> agent override,
      // or the reverse after a local skill is deleted).
      const target = await readlink(link).catch(() => null);
      if (target === source) continue;
      if (existing.isSymbolicLink()) await unlink(link);
      else await rm(link, { recursive: true, force: true });
    }
    await symlink(source, link);
  }
}

/**
 * Link `.claude/skills-src` to the agent's own skills directory.
 *
 * This is where the agent authors skills. `.claude/skills/` is the assembled
 * read/invoke view (core + agent), so creating a directory there would write
 * into the workspace and be swept on the next run; writing through this link
 * lands in the agent definition, where it persists and is visible in the portal.
 *
 * Deliberately a sibling of `.claude/skills`, not inside it — Claude Code only
 * scans `.claude/skills/<name>/SKILL.md`, so this never registers as a skill.
 */
async function ensureSkillsSrcLink(
  agentDir: string,
  workingDirectory: string
): Promise<void> {
  const source = resolve(agentDir, ".claude", "skills");
  const link = resolve(workingDirectory, ".claude", "skills-src");
  // Untracked, so a fresh install starts without one; the link needs a target.
  await mkdir(source, { recursive: true });
  if (await reuseOrClearLink(link, source)) return;
  if (await lstat(link).catch(() => null)) await rm(link, { recursive: true, force: true });
  await mkdir(dirname(link), { recursive: true });
  await symlink(source, link);
}

/**
 * Create an agent launcher bound to specific directories and a runtime.
 */
export function createLauncher(runtime: AgentRuntime, config: LauncherConfig) {
  const {
    agentDir,
    capabilitiesDir,
    resolversDir,
    workspace = workspaceDir(),
    coreSkillsDir = resolve(agentDir, "..", "skills", "core"),
    team = () => [],
  } = config;

  /**
   * Launch an agent execution.
   */
  async function launch(input: AgentInput): Promise<AgentResult> {
    // 1. Load agent config and apply profile overrides
    const baseAgent = await loadAgentConfig(agentDir);
    const roster = team();

    const profile = input.profile ? baseAgent.profiles?.[input.profile] : undefined;
    if (input.profile && !profile) {
      // Don't fail the run — a bad profile name shouldn't take down a scheduled
      // job — but never let it pass silently either.
      console.warn(
        `[Launcher] Unknown profile "${input.profile}" — ` +
          `running the base configuration. Known profiles: ` +
          `${Object.keys(baseAgent.profiles ?? {}).join(", ") || "(none)"}`
      );
    }
    const agent = {
      ...baseAgent,
      capabilities: resolveProfileCapabilities(baseAgent.capabilities, profile),
      resolvers: profile?.resolvers ?? baseAgent.resolvers,
      maxTurns: profile?.maxTurns ?? baseAgent.maxTurns,
      enableChrome: profile?.enableChrome ?? baseAgent.enableChrome,
      configFiles: { ...baseAgent.configFiles, ...profile?.configFiles },
    };

    // 2. Ensure the working directory exists
    const workingDirectory = workspace;
    await mkdir(workingDirectory, { recursive: true });

    // 3. Bootstrap config (seed files, never overwrites existing)
    await bootstrapConfig(agentDir, workingDirectory);

    // 3b. Back up durable memory, and notice anything that vanished from it
    // while no run was in progress. Detection runs before the snapshot, so it
    // compares against what the previous run left behind — see
    // config-journal.ts. A backup must never take down a run, hence the catch.
    let configDrift: ConfigDrift[] = [];
    try {
      configDrift = (await detectConfigDrift(agentDir, workingDirectory)) ?? [];
      for (const drift of configDrift) {
        console.warn(
          `[Launcher] ${drift.relPath} ${drift.deleted ? "was deleted" : "lost content"} ` +
            `outside a run — ${drift.removedLines.length} line(s) gone. ` +
            `Previous version: ${drift.snapshotPath}`
        );
      }
      await journalConfig(agentDir, workingDirectory);
    } catch (err) {
      console.warn(`[Launcher] Config journal failed: ${(err as Error).message}`);
    }

    // 4. Mount skills (core + agent, or just what the profile grants), then
    //    link hooks into the workspace.
    await mountSkills(agentDir, coreSkillsDir, workingDirectory, profile?.skills);
    await ensureSkillsSrcLink(agentDir, workingDirectory);
    const harnessRoot = resolve(agentDir, "..");
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

    // 4b. Load and interpolate the system prompt. It is kept static (no per-run
    // values) so it stays a stable prefix for prompt caching — dynamic values
    // go in the run-context block below instead.
    const promptContext = { ...resolverContext, ...(input.context ?? {}) };
    const systemPrompt = await loadSystemPrompt(agentDir, promptContext);

    // 4c. Build run context preamble — placed AFTER the static system prompt and just
    // before the user message, so the volatile per-run values (identity, time,
    // paths) come last and don't bust the cacheable prefix.
    const contextLines: string[] = [
      `Origin channel: ${input.identity.originChannel}`,
      `Sender: ${input.identity.senderIdentity}`,
      `Trust tier: ${input.identity.trustTier}`,
    ];

    // Generated per-run values
    const now = input.now ?? new Date();
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

    // Team directory — the people this instance serves and how to reach them,
    // from the same roster that drives inbound sender identity, so the addresses
    // the agent invites match the ones the auth gate trusts. Injected ONLY for
    // team-tier runs — a guest run must never receive these private addresses.
    if (input.identity.trustTier === "team") {
      const directory = roster
        .filter((m) => m.emails.length > 0)
        .map(({ name, emails }) => {
          const [primary, ...alts] = emails;
          const altNote = alts.length > 0 ? ` (also: ${alts.join(", ")})` : "";
          return `- ${name}: ${primary}${altNote}`;
        });
      if (directory.length > 0) {
        contextLines.push(
          `Team directory (the people you serve — to put an event on someone's ` +
            `calendar, invite their primary email as an attendee):\n${directory.join("\n")}`
        );
      }

      // Per-member profiles and standing instructions (config/team/<member>.md).
      // These are private, so they're injected ONLY on team-tier runs — never
      // surfaced to a guest. Every *.md is read so new members are picked up
      // without code changes.
      try {
        const membersDir = resolve(workingDirectory, "config", "team");
        const memberFiles = (await readdir(membersDir))
          .filter((f) => f.endsWith(".md"))
          .sort();
        for (const file of memberFiles) {
          const content = (await readFile(resolve(membersDir, file), "utf-8")).trim();
          if (content) {
            contextLines.push(`Team member — ${file.replace(/\.md$/, "")}:\n${content}`);
          }
        }
      } catch {
        // No config/team/ directory yet
      }

      // Durable memory that disappeared between runs. Team-tier only: these
      // files are private, and only a team member can settle whether a removed
      // standing instruction still stands.
      const driftNote = describeConfigDrift(configDrift);
      if (driftNote) contextLines.push(driftNote);
    }

    // The agent's secrets go into a team run's environment, never a guest's.
    // The prompt carries only their names, so a value never enters the context.
    const secrets = input.identity.trustTier === "team" ? await loadAgentSecrets(agentDir) : {};
    const secretNames = Object.keys(secrets).sort();
    if (secretNames.length > 0) {
      contextLines.push(
        `Secrets in your environment (use as $NAME in a command; never print, echo or ` +
          `write out a value): ${secretNames.join(", ")}`
      );
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
      ? await resolveCapabilities(trustFiltered.kept, capabilitiesDir, {
          HARNESS_ROOT: harnessRoot,
          CADDIE_WORKSPACE: workingDirectory,
        })
      : undefined;

    // Tell every capability server where the workspace is, for tools that hand
    // it files, the run's trust tier, for tools that narrow what they do on a
    // guest run, and who is on the team (ids and names only — guest runs get
    // this too, so never addresses), for `email_team`'s recipient list.
    const teamEnv = JSON.stringify(roster.map(({ id, name }) => ({ id, name })));
    const mcpServers = resolved && Object.keys(resolved.servers).length > 0
      ? Object.fromEntries(
          Object.entries(resolved.servers).map(([name, server]) => [
            name,
            {
              ...server,
              env: {
                ...server.env,
                CADDIE_WORKSPACE: workingDirectory,
                CADDIE_TRUST_TIER: trustTier,
                CADDIE_TEAM: teamEnv,
              },
            },
          ])
        )
      : undefined;

    // A capability with unset credentials is skipped, not mounted broken. Log it
    // beside the trust-dropped ones so "why doesn't it have notion?" has one
    // place to look.
    if (resolved?.skipped?.length) {
      for (const { name, missingVars } of resolved.skipped) {
        console.log(
          `[Launcher] Capability "${name}" unavailable this run — unset: ${missingVars.join(", ")}`
        );
      }
    }

    const enableChrome = agent.enableChrome || (resolved?.flags.includes("chrome") ?? false);

    // 7. Build full prompt: system prompt + context preamble + user prompt
    // Always prepend a fresh timestamp so the agent has the current time
    // even on session resumes (where the system prompt is not re-rendered).
    const currentTime = input.context?.currentTime;
    const timeHeader = currentTime ? `[Current time: ${currentTime}]\n\n` : "";
    const userPrompt = `${timeHeader}${input.prompt}`;

    const contextPreamble = contextLines.length > 0 ? contextLines.join("\n\n") + "\n\n---\n\n" : "";
    const fullPrompt = input.sessionId
      ? userPrompt
      : `${systemPrompt}\n\n---\n\n${contextPreamble}${userPrompt}`;

    // 8. Execute via runtime, snapshotting journaled files as they change so a
    // team member's mid-run edit survives the agent overwriting the file.
    const stopWatching = await watchJournal(agentDir, workingDirectory);
    let result;
    try {
      result = await runtime.execute({
        prompt: fullPrompt,
        outputSchema: agent.outputSchema,
        maxTurns: agent.maxTurns ?? DEFAULT_MAX_TURNS,
        workingDirectory,
        sessionId: input.sessionId,
        mcpServers,
        enableChrome,
        disableBuiltinTools: !baseToolsAllowed,
        disallowedTools: resolved?.disallowedTools,
        harnessRoot,
        additionalEnv: { ...secrets, ...input.additionalEnv },
      });
    } finally {
      await stopWatching();
      // 9. Snapshot whatever the run left in config/ and state/. This is the baseline the
      // next run's drift check compares against, so an edit the agent made
      // itself never looks like an out-of-band loss. In a `finally` because a
      // run that crashed still edited files, and a missed snapshot would show
      // up as phantom drift on the next run.
      try {
        const journaled = await journalConfig(agentDir, workingDirectory);
        if (journaled?.length) {
          console.log(`[Launcher] Journaled config changes: ${journaled.join(", ")}`);
        }
      } catch (err) {
        console.warn(`[Launcher] Config journal failed: ${(err as Error).message}`);
      }
    }

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
