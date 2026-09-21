/**
 * Conversation history rendering (pure logic).
 *
 * Each run is a fresh session, so prior turns reach the agent only by being
 * rendered back into the next prompt. What this module decides — how much of
 * each turn survives, and in what order — is the whole of what the agent
 * remembers about a thread.
 */

import { teamMemberLabel } from "@agints/harness";
import type { Message } from "./db";

/** How many recent turns are carried into the next run's prompt. */
export const HISTORY_WINDOW = 20;

/**
 * Total character budget for the rendered history. Spent newest-first, so the
 * most recent turns keep their full text and only the oldest ones in the window
 * are trimmed.
 *
 * This replaced a flat 1000-character cap applied to every message alike, which
 * silently beheaded exactly the messages worth keeping: a venue's long reply
 * listing pricing tiers, inclusions and available dates lost everything after
 * its opening paragraph, and the next run would re-ask for details the other
 * party had already sent in writing.
 */
export const HISTORY_CHAR_BUDGET = 60_000;

/**
 * Below this, what's left of the budget can't hold a useful excerpt — a
 * hundred-character stub of an old message is noise the agent has to read past,
 * so the remaining (older) turns are dropped instead.
 */
const MIN_USEFUL_EXCERPT = 500;

/** Who is speaking, as the prompt labels them. */
export function senderLabel(m: Message): string {
  if (m.role === "assistant") return "Assistant";
  if (!m.sender) return "User";
  if (m.sender.kind === "guest") return "Guest";
  return teamMemberLabel(m.sender.userId);
}

/**
 * Render a history window under {@link HISTORY_CHAR_BUDGET}.
 *
 * Walks newest-first so recency wins the budget, then flips the result back
 * into chronological order — the order matters as much as the content: a
 * history that reads answer-then-question makes the agent re-ask what was
 * already answered.
 */
export function renderHistoryLines(recent: Message[]): string[] {
  const lines: string[] = [];
  let budget = HISTORY_CHAR_BUDGET;

  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    if (budget < MIN_USEFUL_EXCERPT) break;

    let content = m.content;
    if (content.length > budget) {
      const dropped = content.length - budget;
      content =
        content.substring(0, budget) +
        `\n... [truncated — ${dropped} more characters in this message]`;
    }
    budget -= Math.min(m.content.length, budget);
    lines.push(`[${senderLabel(m)}]: ${content}`);
  }

  return lines.reverse();
}
