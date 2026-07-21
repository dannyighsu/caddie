/**
 * Claude Code Transcript Reader
 *
 * Reads session transcripts from Claude Code's local storage.
 * Transcripts are JSONL files at ~/.claude/projects/<project-hash>/<session-id>.jsonl
 */

import { readFile } from "fs/promises";
import { resolve } from "path";
import { homedir } from "os";
import { workspaceRoot } from "./harness";

export interface TranscriptEntry {
  type: "assistant" | "user" | "progress" | "file-history-snapshot" | "last-prompt" | string;
  message?: {
    role?: string;
    model?: string;
    content?: Array<{
      type: string;
      text?: string;
      name?: string;
      input?: Record<string, unknown>;
      tool_use_id?: string;
      content?: unknown;
    }>;
    usage?: Record<string, unknown>;
    stop_reason?: string;
  };
  [key: string]: unknown;
}

export interface TranscriptStep {
  role: "assistant" | "user" | "system";
  type: "text" | "tool_use" | "tool_result" | "thinking" | "progress";
  content: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  timestamp?: string;
}

/**
 * Derive the Claude Code project directory path from a workspace path.
 */
function getProjectDir(agentId: string): string {
  const workspacePath = resolve(workspaceRoot, agentId);
  const projectHash = "-" + workspacePath.replace(/\//g, "-").replace(/^-/, "");
  return resolve(homedir(), ".claude", "projects", projectHash);
}

/**
 * Read and parse a session transcript.
 */
export async function readTranscript(
  agentId: string,
  sessionId: string
): Promise<TranscriptStep[]> {
  const projectDir = getProjectDir(agentId);
  const transcriptPath = resolve(projectDir, `${sessionId}.jsonl`);

  const content = await readFile(transcriptPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  const steps: TranscriptStep[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as TranscriptEntry;

      if (entry.type === "assistant" && entry.message?.content) {
        for (const block of entry.message.content) {
          if (block.type === "text" && block.text) {
            steps.push({
              role: "assistant",
              type: "text",
              content: block.text,
            });
          } else if (block.type === "tool_use") {
            steps.push({
              role: "assistant",
              type: "tool_use",
              content: `${block.name}(${JSON.stringify(block.input ?? {}).substring(0, 200)})`,
              toolName: block.name,
              toolInput: block.input as Record<string, unknown>,
            });
          } else if (block.type === "thinking") {
            const thinkingText = (block as Record<string, unknown>).thinking as string ?? block.text ?? "";
            if (thinkingText) {
              steps.push({
                role: "assistant",
                type: "thinking",
                content: thinkingText,
              });
            }
          }
        }
      } else if (entry.type === "user" && entry.message?.content) {
        const userContent = entry.message.content;

        // Content can be a string (the prompt) or an array of content blocks
        if (typeof userContent === "string") {
          steps.push({ role: "user", type: "text", content: userContent });
        } else if (Array.isArray(userContent)) {
        for (const block of userContent) {
          if (typeof block === "string") {
            steps.push({ role: "user", type: "text", content: block });
          } else if (block.type === "tool_result") {
            const resultText = typeof block.content === "string"
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((c: { text?: string }) => c.text ?? "").join("\n")
                : JSON.stringify(block.content);
            steps.push({
              role: "user",
              type: "tool_result",
              content: resultText.substring(0, 1000),
              toolName: block.tool_use_id,
            });
          } else if (block.type === "text" && block.text) {
            steps.push({ role: "user", type: "text", content: block.text });
          }
        }
        } // end Array.isArray
      }
    } catch {
      // Skip unparseable lines
    }
  }

  return steps;
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
 * infrastructure the household owner must fix (usually re-auth). Returns the
 * last such error found, or null if the session had none / can't be read.
 */
export async function getApiError(
  agentId: string,
  sessionId: string
): Promise<ApiError | null> {
  const projectDir = getProjectDir(agentId);
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
        const text = entry.message?.content
          ?.map((b) => (b.type === "text" ? b.text ?? "" : ""))
          .join("")
          .trim();
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
 * List available session transcripts for an agent.
 */
export async function listTranscripts(
  agentId: string
): Promise<Array<{ sessionId: string; size: number; modified: string }>> {
  const projectDir = getProjectDir(agentId);

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
