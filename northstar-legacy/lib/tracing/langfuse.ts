import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  observe,
  propagateAttributes,
  startActiveObservation,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
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

  langfuseSpanProcessor = new LangfuseSpanProcessor({
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

      return propagateAttributes(
        { sessionId: context.sessionId },
        fn
      );
    }
  );
}

/**
 * Log a harness-level event to Langfuse (timing, errors, etc.).
 */
export function logHarnessEvent(
  name: string,
  data: Record<string, unknown>
): void {
  const config = getAppConfig();
  if (!config.LANGFUSE_ENABLED) return;

  const logFn = observe(
    (input: Record<string, unknown>) => input,
    { name, captureInput: true, captureOutput: true }
  );

  logFn(data);
}

export { langfuseSpanProcessor };
