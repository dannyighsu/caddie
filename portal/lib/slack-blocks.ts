/**
 * Block Kit payload handling for outbound Slack posts (pure logic — no SDK).
 *
 * `post_to_slack` accepts an optional `blocks` array alongside `message`, which
 * Slack then uses as the notification/fallback text. Agents build these blocks
 * in job scripts, so the payload arrives either as a real array or as a JSON
 * string, and sometimes as the `{"blocks": [...]}` wrapper that Block Kit
 * Builder copies out. Normalize all three here, and reject anything Slack would
 * reject with a message that says what to fix — a bad payload returns
 * `invalid_blocks` from Slack with no indication of which block is wrong.
 */

export type SlackBlock = Record<string, unknown>;

/** Slack's per-message cap on `chat.postMessage` blocks. */
export const MAX_BLOCKS = 50;

/**
 * Validate and normalize a caller-supplied `blocks` payload.
 *
 * Returns `{}` when nothing was supplied (a plain text post), `{ blocks }` when
 * the payload is usable, or `{ error }` describing what's wrong. Never throws.
 */
export function normalizeBlocks(
  input: unknown,
): { blocks?: SlackBlock[]; error?: string } {
  if (input === undefined || input === null) return {};

  let value = input;

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      value = JSON.parse(trimmed);
    } catch (err) {
      return { error: `blocks is not valid JSON: ${(err as Error).message}` };
    }
  }

  // Block Kit Builder hands out the whole message payload; take its blocks.
  if (value && !Array.isArray(value) && typeof value === "object") {
    const wrapped = (value as { blocks?: unknown }).blocks;
    if (wrapped !== undefined && wrapped !== null) value = wrapped;
  }

  if (!Array.isArray(value)) {
    return { error: "blocks must be an array of Block Kit blocks" };
  }
  if (value.length === 0) {
    return { error: "blocks is empty — omit it to post plain text" };
  }
  if (value.length > MAX_BLOCKS) {
    return {
      error: `blocks has ${value.length} entries; Slack allows at most ${MAX_BLOCKS} per message`,
    };
  }

  for (const [i, block] of value.entries()) {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return { error: `blocks[${i}] is not an object` };
    }
    const type = (block as SlackBlock).type;
    if (typeof type !== "string" || !type) {
      return { error: `blocks[${i}] is missing a string "type"` };
    }
  }

  return { blocks: value as SlackBlock[] };
}

/**
 * Prepend the `from` attribution as a context block, so a block message carries
 * the same `*[from]*` label the plain-text path adds.
 *
 * Skipped when the payload is already at Slack's block limit — the attribution
 * still rides along in the fallback text, which is better than failing the post.
 */
export function withAttribution(blocks: SlackBlock[], from?: string): SlackBlock[] {
  if (!from || blocks.length >= MAX_BLOCKS) return blocks;
  return [
    { type: "context", elements: [{ type: "mrkdwn", text: `*[${from}]*` }] },
    ...blocks,
  ];
}
