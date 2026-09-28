/**
 * Read tool calls back out of a Claude Code session transcript.
 *
 * The runtime returns only the final text, so the transcript is the record of
 * what the run *did*. Claude Code files it under ~/.claude/projects/<cwd-hash>/;
 * rather than re-deriving that hash (it differs across symlinked temp paths on
 * macOS), the session id is looked up across project dirs.
 */

import { readdir, readFile, copyFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { resolve } from "path";
import type { ToolCall } from "./types.ts";

const PROJECTS = resolve(homedir(), ".claude", "projects");

export async function findTranscript(sessionId: string): Promise<string | undefined> {
  if (!existsSync(PROJECTS)) return undefined;
  for (const dir of await readdir(PROJECTS)) {
    const p = resolve(PROJECTS, dir, `${sessionId}.jsonl`);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface ParsedTranscript {
  toolCalls: ToolCall[];
  finalText?: string;
}

export function parseTranscript(jsonl: string): ParsedTranscript {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  let finalText: string | undefined;

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const content = entry?.message?.content;
    if (!Array.isArray(content)) continue;

    if (entry.type === "assistant") {
      for (const block of content) {
        if (block.type === "tool_use") {
          const fullName = String(block.name);
          calls.set(block.id, {
            name: fullName.includes("__") ? fullName.split("__").pop()! : fullName,
            fullName,
            input: block.input ?? {},
          });
          order.push(block.id);
        } else if (block.type === "text" && block.text?.trim()) {
          finalText = block.text;
        }
      }
    } else if (entry.type === "user") {
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const call = calls.get(block.tool_use_id);
        if (!call) continue;
        call.result = Array.isArray(block.content)
          ? block.content.map((c: any) => c.text ?? "").join("\n")
          : String(block.content ?? "");
        call.isError = !!block.is_error;
      }
    }
  }

  return { toolCalls: order.map((id) => calls.get(id)!), finalText };
}

/**
 * Copy the transcript next to the trial's evidence and remove the sandbox's
 * project dir, so eval runs don't pile up among real sessions.
 */
export async function collectTranscript(sessionId: string, dest: string): Promise<{ path?: string; parsed: ParsedTranscript }> {
  const src = await findTranscript(sessionId);
  if (!src) return { parsed: { toolCalls: [] } };
  const parsed = parseTranscript(await readFile(src, "utf-8"));
  await copyFile(src, dest);
  const projectDir = resolve(src, "..");
  if (projectDir.includes("evals--sandbox")) {
    await rm(projectDir, { recursive: true, force: true });
  }
  return { path: dest, parsed };
}
