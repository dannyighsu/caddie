/**
 * Langfuse Prompt Management
 *
 * Fetches versioned prompts from Langfuse with fallback to hardcoded defaults.
 * Prompt objects are returned for trace linking via experimental_telemetry.
 */

import { LangfuseClient } from "@langfuse/client";
import { getAppConfig } from "../config/app-config";

let client: LangfuseClient | null = null;

function getClient(): LangfuseClient | null {
  const config = getAppConfig();
  if (!config.LANGFUSE_ENABLED) return null;
  if (!client) {
    client = new LangfuseClient();
  }
  return client;
}

export interface PromptResult {
  /** The compiled prompt string (variables substituted) */
  compiled: string;
  /** JSON-serialized Langfuse prompt object for trace linking (null if fallback was used) */
  promptObject: string | null;
}

/**
 * Fetch a text prompt from Langfuse, compile it with variables, and return the result.
 * Falls back to the provided default if Langfuse is disabled or the fetch fails.
 */
export async function getPrompt(
  name: string,
  variables?: Record<string, string>,
  fallback?: string,
): Promise<PromptResult> {
  const lf = getClient();
  if (!lf) {
    return { compiled: fallback ?? "", promptObject: null };
  }

  try {
    const prompt = await lf.prompt.get(name, { type: "text" });
    const compiled = variables ? prompt.compile(variables) : prompt.prompt;
    return { compiled, promptObject: prompt.toJSON() };
  } catch (err) {
    console.warn(`[Langfuse Prompts] Failed to fetch "${name}", using fallback:`, err);
    return { compiled: fallback ?? "", promptObject: null };
  }
}
