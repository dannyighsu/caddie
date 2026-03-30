/**
 * Resolver Runner
 *
 * Loads and executes resolvers declared in an agent config.
 * Returns merged context from all resolvers.
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import type { ResolverDefinition, ResolverModule, ResolverConfig } from "./types.js";

/**
 * Load a resolver definition from its JSON file.
 */
async function loadResolverDefinition(
  resolversDir: string,
  name: string
): Promise<ResolverDefinition> {
  const defPath = resolve(resolversDir, `${name}.json`);
  const content = await readFile(defPath, "utf-8");
  return JSON.parse(content) as ResolverDefinition;
}

/**
 * Check for missing required env vars and log warnings.
 */
function checkRequiredEnv(def: ResolverDefinition): string[] {
  const missing: string[] = [];
  for (const envVar of def.requiredEnv ?? []) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }
  if (missing.length > 0) {
    console.warn(
      `[Resolver] "${def.name}" missing env vars: ${missing.join(", ")}`
    );
  }
  return missing;
}

/**
 * Run all resolvers declared by a agent and return merged context.
 *
 * @param resolverNames - Resolver names from agent config
 * @param resolversDir - Directory containing resolver definitions and modules
 * @param config - Runtime config passed to each resolver
 * @returns Merged key-value context from all resolvers
 */
export async function runResolvers(
  resolverNames: string[],
  resolversDir: string,
  config: ResolverConfig
): Promise<Record<string, string>> {
  const merged: Record<string, string> = {};

  for (const name of resolverNames) {
    try {
      const def = await loadResolverDefinition(resolversDir, name);
      checkRequiredEnv(def);

      // Import the resolver module
      const modulePath = resolve(resolversDir, def.module);
      const mod = (await import(modulePath)) as { default: ResolverModule } | ResolverModule;
      const resolver: ResolverModule = "default" in mod ? mod.default : mod;

      const result = await resolver.resolve(config);
      Object.assign(merged, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[Resolver] "${name}" failed: ${message}`);
      // Don't block the run — just skip this resolver's context
    }
  }

  return merged;
}
