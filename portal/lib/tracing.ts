/**
 * Langfuse Tracing
 *
 * Two integration points:
 * 1. Orchestrator-level traces — created when an agent run starts, updated on completion
 * 2. Claude Code hook events — tool calls, session events forwarded via POST /api/traces
 *
 * Each orchestrated run gets a traceId. The Langfuse URL for a trace is:
 *   {baseUrl}/trace/{traceId}
 *
 * Env vars:
 *   LANGFUSE_SECRET_KEY  — Langfuse secret key
 *   LANGFUSE_PUBLIC_KEY  — Langfuse public key
 *   LANGFUSE_BASE_URL    — Langfuse base URL (defaults to https://us.cloud.langfuse.com)
 */

import { v4 as uuid } from "uuid";

export function isTracingEnabled(): boolean {
  return !!process.env.LANGFUSE_SECRET_KEY && !!process.env.LANGFUSE_PUBLIC_KEY;
}

function getLangfuseBaseUrl(): string {
  return process.env.LANGFUSE_BASE_URL ?? "https://us.cloud.langfuse.com";
}

/**
 * Get the Langfuse URL for a trace.
 */
export function getTraceUrl(traceId: string): string {
  return `${getLangfuseBaseUrl()}/trace/${traceId}`;
}

/**
 * Generate a new trace ID for an agent run.
 */
export function createTraceId(): string {
  return uuid();
}

// --- Langfuse REST API ---

async function langfuseApi(
  path: string,
  body: Record<string, unknown>
): Promise<void> {
  if (!isTracingEnabled()) return;

  const baseUrl = getLangfuseBaseUrl();
  const secretKey = process.env.LANGFUSE_SECRET_KEY!;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY!;
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");

  try {
    await fetch(`${baseUrl}/api/public${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${auth}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.error(`[Langfuse] API call failed:`, err instanceof Error ? err.message : err);
  }
}

/**
 * Create a trace for an agent run.
 */
export async function createTrace(
  traceId: string,
  metadata?: Record<string, unknown>,
  name = "agent-run"
): Promise<void> {
  await langfuseApi("/traces", {
    id: traceId,
    name,
    metadata,
  });
}

/**
 * Add a span to an existing trace (e.g., a tool call from Claude Code hooks).
 */
export async function addSpan(
  traceId: string,
  name: string,
  input?: unknown,
  output?: unknown,
  metadata?: Record<string, unknown>
): Promise<void> {
  await langfuseApi("/spans", {
    traceId,
    name,
    input,
    output,
    metadata,
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
  });
}

/**
 * Log the final result of an agent run to the trace.
 */
export async function completeTrace(
  traceId: string,
  output: Record<string, unknown>
): Promise<void> {
  await langfuseApi("/traces", {
    id: traceId,
    output,
  });
}

/**
 * Process a Claude Code hook event and add it to a trace.
 */
export async function processHookEvent(
  traceId: string,
  event: Record<string, unknown>
): Promise<void> {
  const hookType = event.hook_type as string ?? event.type as string ?? "unknown";
  const toolName = event.tool_name as string ?? event.tool as string;

  const name = toolName ? `${hookType}:${toolName}` : hookType;

  await addSpan(
    traceId,
    name,
    event.tool_input ?? event.input,
    event.tool_result ?? event.output,
    {
      hookType,
      toolName,
      sessionId: event.session_id,
      cwd: event.cwd,
    }
  );
}
