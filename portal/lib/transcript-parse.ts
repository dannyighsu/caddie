/**
 * Transcript parsing — turning the lines of a Claude Code session JSONL into
 * ordered, auditable steps.
 *
 * Kept apart from `transcripts.ts` (which resolves paths and reads files) so
 * the parsing rules can be exercised against a fixture with no transcript on
 * disk and no harness config loaded.
 */

/**
 * How much of a single tool result is kept on a step.
 *
 * A subagent's hand-back report arrives as a tool result and routinely runs to
 * several thousand characters, so a tight cap here silently throws away the
 * part of a run that a delegated answer was actually written from — and it is
 * `content` that `view_run`'s substring search matches against, so anything cut
 * here is unfindable afterwards. Keep enough to audit a report end to end;
 * display budgets belong to the reader, not to the stored step.
 */
export const MAX_TOOL_RESULT_CHARS = 20_000;

export interface TranscriptEntry {
  type: "assistant" | "user" | "progress" | "file-history-snapshot" | "last-prompt" | string;
  /** Claude Code sets this on every entry belonging to a subagent conversation. */
  isSidechain?: boolean;
  message?: {
    role?: string;
    model?: string;
    /** A bare string for a plain prompt; otherwise the usual content blocks. */
    content?: string | Array<{
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
  /** True when this step came from a subagent conversation rather than the parent run. */
  sidechain?: boolean;
}

/** Entry types that carry no conversation content and are not worth a step. */
const NON_CONVERSATION_ENTRY_TYPES = new Set(["file-history-snapshot", "last-prompt"]);

/**
 * The role to attribute an entry's content to.
 *
 * Entries are keyed by `type` ("assistant", "user"), but Claude Code also
 * writes conversation entries under other type names — "progress" and
 * system-injected notifications among them — and those carry the role on
 * `message.role` instead. Falling back to the message's own role is what keeps
 * a subagent's completion notification in the transcript: it arrives on an
 * entry whose `type` is neither "assistant" nor "user", and matching on `type`
 * alone dropped it on the floor.
 */
function roleOf(entry: TranscriptEntry): TranscriptStep["role"] {
  const raw = entry.message?.role ?? entry.type;
  if (raw === "assistant") return "assistant";
  if (raw === "user") return "user";
  return "system";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [truncated ${text.length - max} more characters]`;
}

/** Flatten a tool_result block's `content` (string | blocks | object) to text. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((c: { text?: string }) => c?.text ?? "").join("\n");
  }
  return JSON.stringify(content);
}

/**
 * Parse the lines of a transcript JSONL into ordered steps.
 *
 * Exported separately from `readTranscript` so the parsing rules can be tested
 * against a fixture without a transcript on disk.
 */
export function parseTranscript(content: string): TranscriptStep[] {
  const lines = content.trim().split("\n").filter(Boolean);
  const steps: TranscriptStep[] = [];

  for (const line of lines) {
    let entry: TranscriptEntry;
    try {
      entry = JSON.parse(line) as TranscriptEntry;
    } catch {
      continue; // Skip unparseable lines
    }

    if (NON_CONVERSATION_ENTRY_TYPES.has(entry.type)) continue;
    const blocks = entry.message?.content;
    if (!blocks) continue;

    const role = roleOf(entry);
    const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
    const sidechain = entry.isSidechain === true ? true : undefined;
    const push = (step: Omit<TranscriptStep, "role" | "timestamp" | "sidechain">) =>
      steps.push({ role, ...step, ...(timestamp ? { timestamp } : {}), ...(sidechain ? { sidechain } : {}) });

    // Content can be a bare string (a plain prompt) or an array of blocks.
    if (typeof blocks === "string") {
      push({ type: "text", content: blocks });
      continue;
    }
    if (!Array.isArray(blocks)) continue;

    for (const block of blocks) {
      if (typeof block === "string") {
        push({ type: "text", content: block });
      } else if (block.type === "text" && block.text) {
        push({ type: "text", content: block.text });
      } else if (block.type === "tool_use") {
        push({
          type: "tool_use",
          content: `${block.name}(${JSON.stringify(block.input ?? {}).substring(0, 200)})`,
          toolName: block.name,
          toolInput: block.input as Record<string, unknown>,
        });
      } else if (block.type === "tool_result") {
        push({
          type: "tool_result",
          content: clip(toolResultText(block.content), MAX_TOOL_RESULT_CHARS),
          toolName: block.tool_use_id,
        });
      } else if (block.type === "thinking") {
        const thinkingText = ((block as Record<string, unknown>).thinking as string) ?? block.text ?? "";
        if (thinkingText) push({ type: "thinking", content: thinkingText });
      }
    }
  }

  return steps;
}
