import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { getAppConfig } from "../config/app-config";
import {
  createConfiguredModel,
  DEFAULT_MODEL_ID,
  type ModelId,
} from "./model-config";

let openrouterInstance: ReturnType<typeof createOpenRouter> | null = null;

export function getOpenRouter() {
  if (!openrouterInstance) {
    const config = getAppConfig();
    openrouterInstance = createOpenRouter({
      apiKey: config.OPENROUTER_API_KEY,
    });
  }
  return openrouterInstance;
}

/**
 * Get a configured model instance.
 * @param modelId - The model to use (defaults to google/gemini-3-flash-preview)
 */
export function getModel(modelId?: ModelId) {
  const openrouter = getOpenRouter();
  return createConfiguredModel(openrouter, modelId || DEFAULT_MODEL_ID);
}
