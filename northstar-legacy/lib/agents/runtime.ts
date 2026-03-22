/**
 * Agent Runtime Interface
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
  /** JSON Schema for the expected structured output. */
  outputSchema: Record<string, unknown>;
  /** Maximum agent loop iterations before forced termination. */
  maxTurns: number;
  /** The directory the agent operates in. */
  workingDirectory: string;
  /** If provided, resume a previous session instead of starting a new one. */
  sessionId?: string;
  /** Additional MCP server configurations (e.g., Notion). */
  mcpServers?: Record<string, MCPServerConfig>;
  /** Whether to enable Chrome browser automation. */
  enableChrome?: boolean;
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
}

/**
 * Agent Runtime interface.
 * Implementations wrap a specific agent engine (Claude Code CLI, Codex, etc.).
 */
export interface AgentRuntime {
  readonly name: string;
  execute(input: AgentRuntimeInput): Promise<AgentRuntimeOutput>;
}
