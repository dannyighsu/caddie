/**
 * Per-trial sandbox: a throwaway harness root and workspace.
 *
 * The launcher derives almost everything from `agentDir/..` — permissions,
 * hook settings, config journaling — so pointing it at the real harness would
 * let an eval run journal fake config into `config-history/`. Instead each
 * trial gets:
 *
 *   <runDir>/harness/
 *     permissions.json        copy of the real policy (tiers behave as in prod)
 *     .claude/settings.json   real hook settings + WebFetch/WebSearch blocked
 *     scripts/, skills/core/  → real (read-only in practice)
 *     capabilities/*.json     generated: real MCP servers for the messaging and
 *                             purge tools (pointed at the fake portal), stubs
 *                             for Google, and a stub `local-rag` when the case
 *                             seeds search documents
 *     agent/                  a COPY of the definition (persona, skills), with
 *                             capabilities trimmed to the ones the sandbox
 *                             provides
 *   <runDir>/workspace/config/   the live config, anonymized
 *
 * Deliberately not provided: notion, browser/chrome, web-search, and the
 * `.agent-venv` tools — they reach real services with real credentials. CLIs
 * on the machine's PATH that do the same (gog, gcloud, gh) are shadowed.
 */

import { chmod, cp, mkdir, readFile, readdir, symlink, writeFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { workspaceDir } from "@ignis/harness";
import { Anonymizer, REPO_ROOT, realAddressAliases } from "./team.ts";

const REAL_HARNESS = resolve(REPO_ROOT, "harness");

/**
 * CLIs a run with built-in tools (team tier) could reach real services through.
 * They're on the machine's PATH, not just in `.agent-venv`, so the sandbox puts
 * failing shims in front of them.
 */
const SHADOWED_CLIS = ["gog", "gcloud", "gh"];
const STUB_MCP = resolve(import.meta.dirname, "stub-mcp.mjs");

/** Capabilities an eval run can mount, and how. */
const CAPABILITIES: Record<string, (fixturesFile: string) => object> = {
  reply: () => realTool("reply", "reply-mcp.mjs"),
  email: () => realTool("email", "email-mcp.mjs"),
  "email-team": () => realTool("email-team", "email-team-mcp.mjs"),
  egress: () => realTool("egress", "egress-mcp.mjs"),
  introspect: () => realTool("introspect", "introspect-mcp.mjs"),
  purge: () => realTool("purge", "purge-mcp.mjs"),
  "local-rag": (f) => stub("local-rag", "rag", f),
  "google-calendar": (f) => stub("google-calendar", "calendar", f),
  "google-gmail": (f) => stub("google-gmail", "gmail", f),
};

function realTool(name: string, file: string) {
  return { name, server: { command: "node", args: [resolve(REAL_HARNESS, "tools", file)] } };
}

function stub(name: string, kind: string, fixturesFile: string) {
  return {
    name,
    server: {
      command: "node",
      args: [STUB_MCP],
      env: { EVAL_STUB_KIND: kind, EVAL_FIXTURES_FILE: fixturesFile },
    },
  };
}

export interface Sandbox {
  agentDir: string;
  capabilitiesDir: string;
  /** The agent's working directory inside the sandbox. */
  workspace: string;
  /** Capabilities the agent declared but the sandbox doesn't provide. */
  omitted: string[];
  /** Prepend to PATH: shadows CLIs that reach real services (see SHADOWED_CLIS). */
  binDir: string;
}

/** A document a case seeds into the workspace and the stub search index. */
export interface RagDoc {
  /** Workspace-relative, e.g. `conversations/email/<id>/0003.md`. */
  path: string;
  text: string;
}

export interface SandboxOptions {
  runDir: string;
  fixtures?: Record<string, unknown>;
  /** Source of `config/`; defaults to the live workspace. */
  configDir?: string;
}

export async function createSandbox(opts: SandboxOptions): Promise<Sandbox> {
  const root = resolve(opts.runDir, "harness");
  const agentDir = resolve(root, "agent");
  const capabilitiesDir = resolve(root, "capabilities");
  const workspace = resolve(opts.runDir, "workspace");
  await mkdir(capabilitiesDir, { recursive: true });
  await mkdir(resolve(root, ".claude"), { recursive: true });

  await cp(resolve(REAL_HARNESS, "permissions.json"), resolve(root, "permissions.json"));
  await writeFile(resolve(root, ".claude", "settings.json"), JSON.stringify(await evalSettings(), null, 2));
  await symlink(resolve(REAL_HARNESS, "scripts"), resolve(root, "scripts"));
  await mkdir(resolve(root, "skills"), { recursive: true });
  await symlink(resolve(REAL_HARNESS, "skills", "core"), resolve(root, "skills", "core"));

  // Agent definition — copied, so nothing the run writes lands in the repo.
  const realAgentDir = resolve(REAL_HARNESS, "agent");
  await cp(realAgentDir, agentDir, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(realAgentDir.length);
      return !rel.startsWith("/config-history");
    },
  });

  const agentJsonPath = resolve(agentDir, "agent.json");
  const agentJson = JSON.parse(await readFile(agentJsonPath, "utf-8"));
  const declared: string[] = agentJson.capabilities ?? [];
  // Search is mounted only for cases that seed documents, so every other case
  // runs as if the index were empty/unconfigured rather than against a stub.
  const ragDocs = (opts.fixtures?.rag as RagDoc[] | undefined) ?? [];
  const provided = (c: string) => c in CAPABILITIES && (c !== "local-rag" || ragDocs.length > 0);
  agentJson.capabilities = declared.filter(provided);
  const omitted = declared.filter((c) => !provided(c));
  await writeFile(agentJsonPath, JSON.stringify(agentJson, null, 2));

  const fixturesFile = resolve(opts.runDir, "fixtures.json");
  await writeFile(fixturesFile, JSON.stringify({ ...opts.fixtures, workspace }, null, 2));
  // Seeded documents exist on disk too, so the agent can open what search points at.
  for (const doc of ragDocs) {
    const path = resolve(workspace, doc.path);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, doc.text);
  }
  for (const name of agentJson.capabilities as string[]) {
    await writeFile(resolve(capabilitiesDir, `${name}.json`), JSON.stringify(CAPABILITIES[name](fixturesFile), null, 2));
  }

  // Workspace config: the live standing instructions, with real addresses
  // mapped onto the fake team so they agree with the case files.
  const liveConfig = opts.configDir ?? resolve(workspaceDir(), "config");
  const targetConfig = resolve(workspace, "config");
  await mkdir(targetConfig, { recursive: true });
  if (existsSync(liveConfig)) {
    await copyAnonymized(liveConfig, targetConfig, new Anonymizer(realAddressAliases()));
  }

  const binDir = resolve(opts.runDir, "bin");
  await mkdir(binDir, { recursive: true });
  for (const cli of SHADOWED_CLIS) {
    const shim = resolve(binDir, cli);
    await writeFile(shim, `#!/bin/sh\necho "${cli} is not available in eval runs (it reaches real services)." >&2\nexit 1\n`);
    await chmod(shim, 0o755);
  }

  return { agentDir, capabilitiesDir, workspace, omitted, binDir };
}

/** Built-in tools that reach the live internet; off in every eval run. */
const BLOCKED_BUILTINS = ["WebFetch", "WebSearch"];

/**
 * The real hook settings, plus web access blocked twice over: a deny rule, and
 * a PreToolUse hook — runs use --dangerously-skip-permissions, and a hook that
 * exits 2 blocks the call regardless of permission mode.
 */
async function evalSettings(): Promise<Record<string, any>> {
  const real = JSON.parse(await readFile(resolve(REAL_HARNESS, ".claude", "settings.json"), "utf-8"));
  const hooks = real.hooks ?? {};
  return {
    ...real,
    permissions: { ...(real.permissions ?? {}), deny: [...(real.permissions?.deny ?? []), ...BLOCKED_BUILTINS] },
    hooks: {
      ...hooks,
      PreToolUse: [
        {
          matcher: BLOCKED_BUILTINS.join("|"),
          hooks: [{ type: "command", command: "echo 'Web access is disabled in eval runs.' >&2; exit 2" }],
        },
        ...(hooks.PreToolUse ?? []),
      ],
    },
  };
}

async function copyAnonymized(src: string, dst: string, anon: Anonymizer): Promise<void> {
  for (const entry of await readdir(src)) {
    const from = resolve(src, entry);
    const to = resolve(dst, entry);
    if ((await stat(from)).isDirectory()) {
      await mkdir(to, { recursive: true });
      await copyAnonymized(from, to, anon);
    } else {
      await writeFile(to, anon.text(await readFile(from, "utf-8")));
    }
  }
}
