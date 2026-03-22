/**
 * Workflow Types
 *
 * A workflow = a mode the agent operates in.
 * Defined by a persona (system prompt), a set of capabilities (MCP servers),
 * and optional structured output expectations.
 */

import type { TriggerContext } from "../trigger/types.js";

/**
 * Static workflow configuration, loaded from workflow.json.
 */
export interface WorkflowConfig {
  /** Unique workflow identifier. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Path to persona markdown file (relative to workflow dir), or inline string. */
  persona: string;
  /** Capability names — references to JSON files in the capabilities directory. */
  capabilities: string[];
  /** JSON Schema for structured output. Omit for free-form conversational mode. */
  outputSchema?: Record<string, unknown>;
  /** Maximum agent loop iterations. Defaults to 20. */
  maxTurns?: number;
  /** Whether this workflow needs Chrome browser automation. */
  enableChrome?: boolean;
}

/**
 * Input to launch a workflow execution.
 */
export interface WorkflowInput {
  /** Which workflow to run. */
  workflowId: string;
  /** The user's message or task prompt. */
  prompt: string;
  /** User identifier for workspace isolation. */
  userId?: string;
  /** Resume a prior session for conversation continuation. */
  sessionId?: string;
  /** Template variables injected into the persona ({{key}} -> value). */
  context?: Record<string, string>;
  /** How/why this workflow was triggered. */
  trigger?: TriggerContext;
  /** Override the working directory (otherwise derived from workspaceRoot + userId). */
  workingDirectory?: string;
}

/**
 * Result of a workflow execution.
 */
export interface WorkflowResult {
  success: boolean;
  /** Structured output if the workflow defines an outputSchema. */
  output: Record<string, unknown> | null;
  /** The agent's full text response. */
  rawText: string;
  /** Session ID for resumption. */
  sessionId: string;
  error?: string;
}
