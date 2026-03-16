/**
 * Unified Agent
 *
 * A single agent class that accepts composable tool sets and a system prompt.
 * Replaces the separate NorthstarAgent and XManager sub-agent classes.
 *
 * The agent's behavior is determined by:
 * - The system prompt (provided by a skill module)
 * - The tools (composed from tool sets)
 */

import {
  ToolLoopAgent as Agent,
  hasToolCall,
  stepCountIs,
  type StepResult,
  type ToolSet,
} from "ai";
import type { ModelId } from "../ai/model-config";
import { getModel } from "../ai/openrouter-client";

/**
 * Configuration for the unified agent.
 */
export interface UnifiedAgentConfig {
  sessionId: string;
  modelId?: ModelId;
  maxSteps?: number;
  onStepFinish?: <T extends ToolSet>(stepResult: StepResult<T>) => void;
}

/**
 * Result from executing the unified agent.
 */
export interface UnifiedAgentResult {
  text: string;
  steps: Array<{
    toolResults: Array<{ toolName: string; output: unknown }>;
  }>;
}

/**
 * Options for a single agent execution.
 */
export interface ExecuteOptions {
  /** The system prompt (typically from a skill module) */
  systemPrompt: string;
  /** The merged tool set for this execution */
  tools: ToolSet;
  /** Langfuse prompt object for trace linking */
  langfusePromptObject?: string | null;
  /** Function ID for telemetry (e.g., "northstar-agent", "xmanager-feed-scanner") */
  functionId?: string;
}

/**
 * Unified agent that can be configured with different prompts and tool sets
 * for different execution modes (check-in, conversation, X Manager tasks).
 */
export class UnifiedAgent {
  private config: UnifiedAgentConfig;

  constructor(config: UnifiedAgentConfig) {
    this.config = {
      maxSteps: 20,
      ...config,
    };
  }

  /**
   * Execute the agent with the given prompt and options.
   */
  async execute(
    prompt: string,
    options: ExecuteOptions
  ): Promise<UnifiedAgentResult> {
    const model = getModel(this.config.modelId);

    const agent = new Agent({
      model,
      instructions: options.systemPrompt,
      tools: options.tools,
      stopWhen: [
        hasToolCall("finish"),
        stepCountIs(this.config.maxSteps!),
      ],
      onStepFinish: this.config.onStepFinish,
      experimental_telemetry: {
        isEnabled: true,
        functionId: options.functionId || "northstar-agent",
        metadata: {
          sessionId: this.config.sessionId,
          ...(options.langfusePromptObject
            ? { langfusePrompt: options.langfusePromptObject }
            : {}),
        },
        recordInputs: false,
        recordOutputs: false,
      },
    });

    const result = await agent.generate({ prompt });

    return {
      text: result.text || "",
      steps: result.steps,
    };
  }
}
