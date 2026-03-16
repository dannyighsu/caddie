/**
 * Model Configuration
 *
 * Centralized configuration for different LLM providers and their reasoning parameters.
 * Each provider has different parameter formats for enabling reasoning/thinking.
 */

import type { createOpenRouter } from "@openrouter/ai-sdk-provider";

export type ModelId =
  | "google/gemini-3-flash-preview"
  | "google/gemini-3-pro-preview"
  | "openai/gpt-5.2-chat"
  | "anthropic/claude-sonnet-4.5";

export interface ModelConfig {
  id: ModelId;
  name: string;
  provider: "google" | "openai" | "anthropic";
  description: string;
  supportsReasoning: boolean;
}

export const AVAILABLE_MODELS: Record<ModelId, ModelConfig> = {
  "google/gemini-3-flash-preview": {
    id: "google/gemini-3-flash-preview",
    name: "Gemini 3 Flash Preview",
    provider: "google",
    description: "Fast, cost-effective model with reasoning",
    supportsReasoning: true,
  },
  "google/gemini-3-pro-preview": {
    id: "google/gemini-3-pro-preview",
    name: "Gemini 3 Pro Preview",
    provider: "google",
    description: "Flagship model with strong multimodal reasoning",
    supportsReasoning: true,
  },
  "openai/gpt-5.2-chat": {
    id: "openai/gpt-5.2-chat",
    name: "GPT-5.2",
    provider: "openai",
    description: "OpenAI's latest reasoning model",
    supportsReasoning: true,
  },
  "anthropic/claude-sonnet-4.5": {
    id: "anthropic/claude-sonnet-4.5",
    name: "Claude 4.5 Sonnet",
    provider: "anthropic",
    description: "Extended thinking with tool use",
    supportsReasoning: true,
  },
};

export const DEFAULT_MODEL_ID: ModelId = "google/gemini-3-flash-preview";

/**
 * Get model configuration for a given model ID.
 * Returns the default model config if the provided ID is invalid.
 */
export function getModelConfig(modelId: string | undefined): ModelConfig {
  if (!modelId || !(modelId in AVAILABLE_MODELS)) {
    return AVAILABLE_MODELS[DEFAULT_MODEL_ID];
  }
  return AVAILABLE_MODELS[modelId as ModelId];
}

/**
 * Create a configured model instance with appropriate reasoning parameters.
 */
export function createConfiguredModel(
  openrouter: ReturnType<typeof createOpenRouter>,
  modelId: ModelId = DEFAULT_MODEL_ID
) {
  const config = AVAILABLE_MODELS[modelId];

  // Configure reasoning parameters based on provider
  switch (config.provider) {
    case "google":
      // Gemini 3 uses OpenRouter's unified reasoning.effort parameter
      // Maps to thinkingLevel (minimal/low/medium/high) in Google's native API
      return openrouter(modelId, {
        extraBody: {
          reasoning: {
            effort: "low", // Options: "minimal", "low", "medium", "high"
          },
        },
      });

    case "openai":
      // OpenAI uses effort and summary parameters
      return openrouter(modelId, {
        extraBody: {
          reasoning: {
            effort: "low",
            summary: "auto", // Request reasoning summaries
          },
        },
      });

    case "anthropic":
      // Claude uses effort parameter
      // Note: Has known issues with thinking block preservation in multi-turn tool calling
      return openrouter(modelId, {
        extraBody: {
          reasoning: {
            effort: "low",
          },
        },
      });

    default:
      // Fallback without reasoning
      return openrouter(modelId);
  }
}
