/**
 * Harness Integration
 *
 * Creates and caches the runtime + launcher from @agints/harness.
 * All API routes use getLauncher() to access the shared instance.
 */

import { resolve } from "path";
import { createRuntime, createLauncher } from "@agints/harness";
import type { WorkflowConfig } from "@agints/harness";
import { readdir, readFile } from "fs/promises";

// The harness package lives alongside northstar in the monorepo
const harnessRoot = resolve(process.cwd(), "..", "harness");

let launcherInstance: ReturnType<typeof createLauncher> | null = null;

export function getLauncher() {
  if (!launcherInstance) {
    const runtime = createRuntime();
    launcherInstance = createLauncher(runtime, {
      workflowsDir: resolve(harnessRoot, "workflows"),
      capabilitiesDir: resolve(harnessRoot, "capabilities"),
      workspaceRoot: resolve(process.cwd(), "workspace"),
    });
  }
  return launcherInstance;
}

/**
 * List all available workflows by reading the harness/workflows directory.
 */
export async function listWorkflows(): Promise<WorkflowConfig[]> {
  const workflowsDir = resolve(harnessRoot, "workflows");
  const entries = await readdir(workflowsDir, { withFileTypes: true });
  const workflows: WorkflowConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const configPath = resolve(workflowsDir, entry.name, "workflow.json");
      const content = await readFile(configPath, "utf-8");
      workflows.push(JSON.parse(content) as WorkflowConfig);
    } catch {
      // Skip directories without a valid workflow.json
    }
  }

  return workflows;
}

/**
 * Get a single workflow config by ID.
 */
export async function getWorkflow(id: string): Promise<WorkflowConfig | null> {
  const workflowsDir = resolve(harnessRoot, "workflows");
  try {
    const configPath = resolve(workflowsDir, id, "workflow.json");
    const content = await readFile(configPath, "utf-8");
    return JSON.parse(content) as WorkflowConfig;
  } catch {
    return null;
  }
}
