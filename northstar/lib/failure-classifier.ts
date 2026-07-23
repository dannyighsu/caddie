/**
 * Run Failure Classifier
 *
 * A run that ends `success: false` failed for one of two categorically
 * different reasons, and callers need to tell them apart:
 *
 *   - "api"   — the Claude API call itself failed before the agent could do its
 *               work: expired OAuth, rate limit, overload, credit/usage cap.
 *               Infrastructure the household owner must fix (usually re-auth).
 *   - "agent" — the agent ran but returned an error on its task (non-zero exit,
 *               max turns exhausted, output-schema validation, a thrown tool).
 *
 * The canonical signal for an API-layer failure is the synthetic
 * `isApiErrorMessage` entry Claude Code writes into the session transcript;
 * `getApiError` reads it. When no transcript exists (the process died before the
 * session envelope was written), we fall back to matching the error string.
 *
 * This is shared by run-alerts (which emails the owner only on "api" failures)
 * and the job-run ledger (which records the class on every failed run).
 */

import { getApiError } from "./transcripts";

/** Which layer a failed run failed at. */
export type FailureClass = "api" | "agent";

export interface ClassifiedFailure {
  failureClass: FailureClass;
  /** Machine code where available (e.g. "authentication_failed"), else "api_error"/"agent_error". */
  code: string;
  /** Human-readable detail for alerts and the ledger. */
  detail: string;
}

// Fallback signatures for when the run died before a session transcript existed
// (no sessionId to inspect). Matched case-insensitively against result.error.
const API_ERROR_SIGNATURES = [
  "authentication_failed",
  "failed to authenticate",
  "oauth",
  "overloaded",
  "rate limit",
  "rate_limit",
  "usage limit",
  "credit balance",
];

function matchesApiSignature(error: string | undefined): boolean {
  if (!error) return false;
  const e = error.toLowerCase();
  return API_ERROR_SIGNATURES.some((sig) => e.includes(sig));
}

/**
 * Classify a failed run. Returns null for a successful run (nothing to classify).
 * Never throws — a transcript read failure degrades to string matching.
 */
export async function classifyRunFailure(
  agentId: string,
  result: { success: boolean; error?: string; sessionId?: string }
): Promise<ClassifiedFailure | null> {
  if (result.success) return null;

  // Canonical signal: the transcript's synthetic API-error entry.
  if (result.sessionId) {
    const apiErr = await getApiError(agentId, result.sessionId).catch(() => null);
    if (apiErr) {
      return { failureClass: "api", code: apiErr.type, detail: apiErr.message };
    }
  }

  // Fall back to matching the error string when no transcript is available.
  if (matchesApiSignature(result.error)) {
    return {
      failureClass: "api",
      code: "api_error",
      detail: result.error ?? "Unknown API-layer error",
    };
  }

  // The agent ran and returned an ordinary task error.
  return {
    failureClass: "agent",
    code: "agent_error",
    detail: result.error ?? "Unknown agent error",
  };
}
