/**
 * Agent Runtime Interfaces
 *
 * Defines the contract for agent runtime implementations.
 * The runtime encapsulates the agent loop (LLM interaction, tool execution, response generation).
 * Execution services use this interface without knowledge of the underlying engine.
 */

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AgentRuntimeInput {
  /** The full task prompt including persona, context, and instructions. */
  prompt: string;
  /** JSON Schema for the expected structured output. Optional for conversational mode. */
  outputSchema?: Record<string, unknown>;
  /** Maximum agent loop iterations before forced termination. */
  maxTurns: number;
  /** The directory the agent operates in. */
  workingDirectory: string;
  /** If provided, resume a previous session instead of starting a new one. */
  sessionId?: string;
  /** MCP server configurations for capabilities. */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Whether to enable Chrome browser automation. */
  enableChrome?: boolean;
  /**
   * If true, disable ALL built-in Claude Code tools (Bash, Read, Write, Edit,
   * WebFetch, ...) for this run. MCP tools (mounted via mcpServers) are
   * unaffected. Driven by the `base-tools` permission for the run's trust tier.
   */
  disableBuiltinTools?: boolean;
  /**
   * Fully qualified tool names (e.g. `mcp__local-rag__delete_file`) removed from
   * this run entirely. Comes from capabilities' `disallowedTools`.
   */
  disallowedTools?: string[];
  /** Absolute path to the harness root directory (for hook scripts). */
  harnessRoot?: string;
  /** Runtime-specific additional arguments (escape hatch). */
  additionalArgs?: string[];
  /** Additional environment variables for the subprocess. */
  additionalEnv?: Record<string, string>;
}

export interface AgentRuntimeOutput {
  /** Structured output matching the provided schema, or null on failure. */
  output: Record<string, unknown> | null;
  /** Session identifier for this execution, usable for resumption. */
  sessionId: string;
  /** The agent's full text response. */
  rawText: string;
  /** Error description if the execution failed. */
  error?: string;
  /** Token usage and cost metadata from the runtime, if available. */
  usage?: Record<string, unknown>;
}

/**
 * Agent Runtime interface.
 * Implementations wrap a specific agent engine (Claude Code CLI, Codex, etc.).
 */
export interface AgentRuntime {
  readonly name: string;
  execute(input: AgentRuntimeInput): Promise<AgentRuntimeOutput>;
}
