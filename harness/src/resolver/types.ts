/**
 * Resolver Types
 *
 * Resolvers are deterministic data-fetchers that run before the agent launch.
 * They inject their results into the template context ({{key}} -> value).
 *
 * Use resolvers for data the agent always needs at the start of a run
 * (calendar events, system status, etc.) as opposed to MCP servers
 * which provide interactive tools the agent calls during execution.
 */

/**
 * Static resolver definition, loaded from a JSON file in the resolvers directory.
 */
export interface ResolverDefinition {
  name: string;
  description?: string;
  /** Module path relative to the resolvers directory (e.g., "./google-calendar.ts"). */
  module: string;
  /** Env vars this resolver needs. Missing vars produce warnings, not errors. */
  requiredEnv?: string[];
}

/**
 * Config passed to each resolver at execution time.
 */
export interface ResolverConfig {
  /** The workflow's working directory. */
  workingDirectory: string;
  /** Root directory of the harness package (for credentials, etc.). */
  harnessRoot: string;
}

/**
 * Interface that resolver modules must implement.
 * The module's default export should be a ResolverModule.
 */
export interface ResolverModule {
  /**
   * Fetch data and return key-value pairs to merge into template context.
   * Should handle errors gracefully and return fallback values on failure.
   */
  resolve(config: ResolverConfig): Promise<Record<string, string>>;
}
