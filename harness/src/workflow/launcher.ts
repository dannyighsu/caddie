/**
 * Workflow Launcher
 *
 * The core function of the harness. Loads a workflow config, resolves its
 * persona and capabilities, and delegates execution to the agent runtime.
 *
 * No scheduling, no messaging, no persistence — those are the caller's job.
 */

import { readFile, mkdir } from "fs/promises";
import { resolve } from "path";
import type { AgentRuntime } from "../runtime/types.js";
import { resolveCapabilities } from "../capability/mcp-resolver.js";
import type { WorkflowConfig, WorkflowInput, WorkflowResult } from "./types.js";

const TEMPLATE_VAR_PATTERN = /\{\{(\w+)\}\}/g;
const DEFAULT_MAX_TURNS = 20;

export interface LauncherConfig {
  /** Directory containing workflow subdirectories. */
  workflowsDir: string;
  /** Directory containing capability JSON files. */
  capabilitiesDir: string;
  /** Root directory for agent workspaces. Defaults to <cwd>/workspace. */
  workspaceRoot?: string;
}

/**
 * Load and parse a workflow.json config file.
 */
async function loadWorkflowConfig(
  workflowsDir: string,
  workflowId: string
): Promise<{ config: WorkflowConfig; workflowDir: string }> {
  const workflowDir = resolve(workflowsDir, workflowId);
  const configPath = resolve(workflowDir, "workflow.json");
  const content = await readFile(configPath, "utf-8");
  const config = JSON.parse(content) as WorkflowConfig;
  return { config, workflowDir };
}

/**
 * Load and interpolate the persona template.
 */
async function loadPersona(
  personaRef: string,
  workflowDir: string,
  context: Record<string, string>
): Promise<string> {
  let template: string;

  if (personaRef.startsWith("./") || personaRef.endsWith(".md")) {
    // File reference — load from disk
    const personaPath = resolve(workflowDir, personaRef);
    template = await readFile(personaPath, "utf-8");
  } else {
    // Inline persona string
    template = personaRef;
  }

  // Interpolate {{key}} template variables
  return template.replace(TEMPLATE_VAR_PATTERN, (match, key) => {
    return context[key] ?? match; // Leave unresolved vars as-is
  });
}

/**
 * Create a workflow launcher bound to specific directories and a runtime.
 */
export function createLauncher(runtime: AgentRuntime, config: LauncherConfig) {
  const {
    workflowsDir,
    capabilitiesDir,
    workspaceRoot = resolve(process.cwd(), "workspace"),
  } = config;

  /**
   * Launch a workflow execution.
   */
  async function launch(input: WorkflowInput): Promise<WorkflowResult> {
    // 1. Load workflow config
    const { config: wf, workflowDir } = await loadWorkflowConfig(
      workflowsDir,
      input.workflowId
    );

    // 2. Load and interpolate persona
    const persona = await loadPersona(
      wf.persona,
      workflowDir,
      input.context ?? {}
    );

    // 3. Resolve MCP capabilities
    const resolved = wf.capabilities.length > 0
      ? await resolveCapabilities(wf.capabilities, capabilitiesDir)
      : undefined;

    const mcpServers = resolved && Object.keys(resolved.servers).length > 0
      ? resolved.servers
      : undefined;

    // Chrome can be enabled via workflow config or via the "chrome" flag capability
    const enableChrome = wf.enableChrome || (resolved?.flags.includes("chrome") ?? false);

    // 4. Determine working directory and ensure it exists
    const workingDirectory =
      input.workingDirectory ??
      resolve(workspaceRoot, input.userId ?? "default", wf.id);
    await mkdir(workingDirectory, { recursive: true });

    // 5. Build full prompt: persona + user prompt
    const fullPrompt = input.sessionId
      ? input.prompt // Session resumption — runtime has prior context
      : `${persona}\n\n---\n\n${input.prompt}`;

    // 6. Execute via runtime
    const result = await runtime.execute({
      prompt: fullPrompt,
      outputSchema: wf.outputSchema,
      maxTurns: wf.maxTurns ?? DEFAULT_MAX_TURNS,
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
