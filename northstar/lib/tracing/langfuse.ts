import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  observe,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { StepResult, ToolSet } from "ai";
import { v4 as uuidv4 } from "uuid";
import { getAppConfig } from "../config/app-config";

let sdk: NodeSDK | null = null;
let langfuseSpanProcessor: LangfuseSpanProcessor | null = null;

/**
 * Initialize Langfuse OpenTelemetry integration.
 * Call this once at server startup (in instrumentation.ts).
 */
export function initializeLangfuse(): void {
  const config = getAppConfig();

  if (!config.LANGFUSE_ENABLED) {
    console.log("[Langfuse] Tracing disabled");
    return;
  }

  // Filter out unwanted spans to reduce noise
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shouldExportSpan = (span: { otelSpan: any }) => {
    const otelSpan = span.otelSpan;
    const name = otelSpan.name as string;

    // Debug: uncomment to see span structure
    // console.log("[Langfuse] Span:", name, "| keys:", Object.keys(otelSpan).join(", "));

    // Filter out Next.js internal spans by name pattern
    if (name.startsWith("next.") || name.startsWith("Next.js")) {
      return false;
    }

    // Filter out AI SDK tool execution spans
    // The AI SDK creates tool spans with name "ai.toolCall"
    // These are duplicative of our manual step-N spans which include tool details
    if (name === "ai.toolCall") {
      return false;
    }

    return true;
  };

  langfuseSpanProcessor = new LangfuseSpanProcessor({
    shouldExportSpan,
    secretKey: config.LANGFUSE_SECRET_KEY,
    publicKey: config.LANGFUSE_PUBLIC_KEY,
    baseUrl: config.LANGFUSE_BASE_URL,
  });

  sdk = new NodeSDK({
    spanProcessors: [langfuseSpanProcessor],
  });

  sdk.start();

  console.log("[Langfuse] Tracing initialized successfully");
}

/**
 * Force flush pending traces - call before serverless function returns.
 */
export async function flushLangfuse(): Promise<void> {
  if (langfuseSpanProcessor) {
    await langfuseSpanProcessor.forceFlush();
  }
}

/**
 * Generate a new session ID for an agent run.
 */
export function generateSessionId(prefix: string = "session"): string {
  return `${prefix}-${uuidv4()}`;
}

/**
 * Tracing context for agent executions.
 */
export interface TracingContext {
  sessionId: string;
  agentType: "northstar" | "xmanager";
  runType?: "check-in" | "conversation" | "scheduled";
}

/**
 * Execute a function with Langfuse session context propagated.
 * All observations within the callback inherit the session ID.
 */
export async function withLangfuseSession<T>(
  context: TracingContext,
  fn: () => Promise<T>
): Promise<T> {
  const config = getAppConfig();

  if (!config.LANGFUSE_ENABLED) {
    return fn();
  }

  return startActiveObservation(
    `${context.agentType}-${context.runType || "run"}`,
    async (span) => {
      span.update({
        metadata: {
          agentType: context.agentType,
          runType: context.runType,
        },
      });

      // Propagate session ID to all child observations
      return propagateAttributes(
        { sessionId: context.sessionId },
        fn
      );
    }
  );
}

/**
 * Log an agent step to Langfuse with reasoning, tool calls, and results.
 * Call this from onStepFinish callback.
 *
 * StepResult fields (from Vercel AI SDK):
 * - text: The assistant's generated text response
 * - reasoningText: The model's reasoning/thinking text (if using reasoning models)
 * - reasoning: Array of detailed reasoning outputs (if using reasoning models)
 * - toolCalls: Array of tool calls, each with `input` (not `args`)
 * - toolResults: Array of tool results, each with `output` (not `result`)
 * - finishReason: Why the step ended ("stop", "tool-calls", etc.)
 */
export function logAgentStep<T extends ToolSet>(
  stepNumber: number,
  stepResult: StepResult<T>
): void {
  const config = getAppConfig();

  if (!config.LANGFUSE_ENABLED) {
    return;
  }

  // Build tool calls data with correct field names
  const toolCallsData = (stepResult.toolCalls || []).map((toolCall) => {
    // Find matching tool result by toolCallId for accurate pairing
    const toolResult = stepResult.toolResults?.find(
      (r) => r.toolCallId === toolCall.toolCallId
    );

    // Safely serialize tool input, truncating if too large
    let input: unknown;
    try {
      const inputJson = JSON.stringify(toolCall.input);
      if (inputJson.length > 10000) {
        input = { _truncated: true, _preview: inputJson.substring(0, 500) };
      } else {
        input = toolCall.input;
      }
    } catch (e) {
      input = { _error: "unable to serialize", _message: String(e) };
    }

    // Safely serialize tool output, truncating if too large
    let output: unknown;
    try {
      const outputJson = JSON.stringify(toolResult?.output);
      if (outputJson.length > 10000) {
        output = { _truncated: true, _preview: outputJson.substring(0, 500) };
      } else {
        output = toolResult?.output;
      }
    } catch (e) {
      output = { _error: "unable to serialize", _message: String(e) };
    }

    return {
      toolName: toolCall.toolName,
      toolCallId: toolCall.toolCallId,
      input,
      output,
    };
  });

  // Extract reasoning details if available
  // The AI SDK provides both reasoningText (string) and reasoning (array of detailed outputs)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reasoning = (stepResult as any).reasoning || null;

  // Safely serialize reasoning array, truncating if too large
  let reasoningData: unknown = null;
  if (reasoning && Array.isArray(reasoning)) {
    try {
      const reasoningJson = JSON.stringify(reasoning);
      if (reasoningJson.length > 20000) {
        // Keep first few reasoning blocks and mark as truncated
        const truncated = reasoning.slice(0, 3);
        reasoningData = {
          _truncated: true,
          _totalBlocks: reasoning.length,
          _preview: truncated,
        };
      } else {
        reasoningData = reasoning;
      }
    } catch (e) {
      reasoningData = { _error: "unable to serialize", _message: String(e) };
    }
  }

  // Use observe to create a span that inherits the active trace context
  const logStep = observe(
    (data: {
      text: string | null;
      reasoningText: string | null;
      reasoning: unknown;
      finishReason: string;
      toolCalls: typeof toolCallsData;
    }) => {
      return data;
    },
    {
      name: `step-${stepNumber}`,
      captureInput: true,
      captureOutput: true,
    }
  );

  // Log with correct field semantics:
  // - text: what the assistant said
  // - reasoningText: the model's internal reasoning as text (if available)
  // - reasoning: detailed reasoning array from OpenRouter/OpenAI (if available)
  logStep({
    text: stepResult.text || null,
    reasoningText: stepResult.reasoningText || null,
    reasoning: reasoningData,
    finishReason: stepResult.finishReason,
    toolCalls: toolCallsData,
  });
}

/**
 * Log an agent error to Langfuse.
 * Call this from onError callback to capture provider errors and exceptions.
 */
function logAgentError(error: unknown): void {
  const config = getAppConfig();

  if (!config.LANGFUSE_ENABLED) {
    return;
  }

  // Extract error details
  let errorMessage = "Unknown error";
  let errorStack = undefined;
  let errorName = "Error";

  if (error instanceof Error) {
    errorMessage = error.message;
    errorStack = error.stack;
    errorName = error.name;
  } else if (typeof error === "string") {
    errorMessage = error;
  } else {
    try {
      errorMessage = JSON.stringify(error);
    } catch {
      errorMessage = String(error);
    }
  }

  // Use observe to create an error span that inherits the active trace context
  const logError = observe(
    (data: { errorName: string; errorMessage: string; errorStack?: string }) => {
      return data;
    },
    {
      name: "agent-error",
      captureInput: true,
      captureOutput: true,
    }
  );

  logError({
    errorName,
    errorMessage,
    errorStack,
  });
}

export { langfuseSpanProcessor, logAgentError };
