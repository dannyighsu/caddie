/**
 * Claude Code Transcript Reader
 *
 * Reads session transcripts from Claude Code's local storage.
 * Transcripts are JSONL files at ~/.claude/projects/<project-hash>/<session-id>.jsonl
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import { homedir } from "os";
import { workspace } from "./harness";
import { parseTranscript } from "./transcript-parse";
import type { TranscriptEntry, TranscriptStep } from "./transcript-parse";

export { parseTranscript, MAX_TOOL_RESULT_CHARS } from "./transcript-parse";
export type { TranscriptEntry, TranscriptStep } from "./transcript-parse";

/**
 * Read and parse a session transcript.
 */
export async function readTranscript(sessionId: string): Promise<TranscriptStep[]> {
  const projectDir = getProjectDir();
  const transcriptPath = resolve(projectDir, `${sessionId}.jsonl`);
  return parseTranscript(await readFile(transcriptPath, "utf-8"));
}

/**
 * The Claude Code project directory for the workspace.
 */
function getProjectDir(): string {
  // Claude Code maps every non-alphanumeric character to "-" — not just "/"
  // (e.g. the "." in ~/.caddie).
  const projectHash = workspace.replace(/[^a-zA-Z0-9]/g, "-");
  return resolve(homedir(), ".claude", "projects", projectHash);
}

export interface ApiError {
  /** Machine error code Claude Code assigns, e.g. "authentication_failed". */
  type: string;
  /** Human-readable text from the synthetic error message. */
  message: string;
}

/**
 * Detect an API-layer failure in a session transcript.
 *
 * When the Claude API call itself fails — expired OAuth, rate limit, overload —
 * Claude Code appends a synthetic assistant entry stamped
 * `isApiErrorMessage: true` (with `model: "<synthetic>"`) carrying an `error`
 * code. That is categorically different from an agent that ran and returned an
 * error on its task: the run never got off the ground, and the cause is
 * infrastructure the team owner must fix (usually re-auth). Returns the
 * last such error found, or null if the session had none / can't be read.
 */
export async function getApiError(sessionId: string): Promise<ApiError | null> {
  const projectDir = getProjectDir();
  const transcriptPath = resolve(projectDir, `${sessionId}.jsonl`);

  let content: string;
  try {
    content = await readFile(transcriptPath, "utf-8");
  } catch {
    return null; // No transcript on disk — nothing to inspect.
  }

  const lines = content.trim().split("\n").filter(Boolean);
  let found: ApiError | null = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as TranscriptEntry & {
        isApiErrorMessage?: boolean;
        error?: string;
      };
      if (entry.isApiErrorMessage === true) {
        const content = entry.message?.content;
        const text = (typeof content === "string"
          ? content
          : Array.isArray(content)
            ? content.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("")
            : ""
        ).trim();
        found = {
          type: entry.error ?? "api_error",
          message: text || entry.error || "API-layer failure",
        };
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return found;
}

/**
 * List available session transcripts.
 */
export async function listTranscripts(): Promise<Array<{ sessionId: string; size: number; modified: string }>> {
  const projectDir = getProjectDir();

  try {
    const { readdir, stat } = await import("fs/promises");
    const entries = await readdir(projectDir);
    const transcripts: Array<{ sessionId: string; size: number; modified: string }> = [];

    for (const entry of entries) {
      if (!entry.endsWith(".jsonl")) continue;
      const sessionId = entry.replace(".jsonl", "");
      try {
        const info = await stat(resolve(projectDir, entry));
        transcripts.push({
          sessionId,
          size: info.size,
          modified: info.mtime.toISOString(),
        });
      } catch {
        // Skip
      }
    }

    return transcripts.sort((a, b) => b.modified.localeCompare(a.modified));
  } catch {
    return [];
  }
}
