/**
 * Inbound prompt assembly (pure logic).
 *
 * Everything an inbound-message run sees beyond the persona and run context:
 * source-task facts, the delivery contract, the channel envelope, conversation
 * history, the current message, and referenced attachments. Kept free of DB and
 * launcher imports so the eval runner (evals/) builds the exact prompt
 * production does — an eval against a hand-copied prompt tests the copy.
 */

import { teamMemberLabel } from "@agints/harness";
import type { Message } from "./db";
import type { ResolvedIdentity } from "./identity";
import { renderThreadContext, type ThreadContext } from "./thread-context";
import { HISTORY_WINDOW, renderHistoryLines } from "./conversation-history";

/** A file attachment from any channel, already downloaded to the workspace. */
export interface Attachment {
  /** Absolute path to the downloaded file in the workspace artifacts directory */
  filePath: string;
  /** Original filename */
  fileName: string;
  /** MIME type */
  mimeType: string;
  /** Whether this is an image that should be included in prompt context */
  isImage: boolean;
}

export interface InboundPromptInput {
  /** Prior turns of this conversation, oldest first (the pre-append snapshot). */
  messages: Message[];
  /** The current inbound message. */
  text: string;
  identity: ResolvedIdentity;
  /** "tool": the agent must call `reply` to say anything. */
  deliveryMode: "auto" | "tool";
  /** Channel run-context, e.g. the email envelope. Prompt-only, never persisted. */
  promptContext?: string;
  /** Set when the thread was created by one of the agent's own tasks. */
  threadContext?: ThreadContext | null;
  attachments?: Attachment[];
}

export function assembleInboundPrompt(input: InboundPromptInput): string {
  // If this thread was created by one of the agent's own tasks (e.g. a
  // recurring reminder), prepend the source-task facts so the agent can trace
  // the reply back to the task and act on it (e.g. stop the reminder).
  const taskPreamble = input.threadContext
    ? renderThreadContext(input.threadContext) + "\n\n---\n\n"
    : "";
  // Make the delivery contract explicit for this run rather than leaving the
  // agent to infer it — driven by the same `deliveryMode` flag that actually
  // governs delivery, so instruction and behavior can't drift. Only emitted in
  // "tool" mode; "auto" runs (portal, Slack, Telegram) deliver the final text.
  const deliveryPreamble =
    input.deliveryMode === "tool"
      ? "This is an inbound-message run: respond with the `reply` tool (your final " +
        "text is not delivered), or stay silent by not calling it if no reply is " +
        "warranted.\n\n---\n\n"
      : "";
  // Channel run-context (e.g. the email envelope) sits between any task
  // preamble and the conversation history.
  const channelPreamble = input.promptContext ? input.promptContext + "\n\n---\n\n" : "";
  return (
    taskPreamble +
    deliveryPreamble +
    channelPreamble +
    buildPromptWithHistory(input.messages, input.text, input.identity, input.attachments)
  );
}

function currentMessageLabel(identity: ResolvedIdentity): string {
  if (identity.kind === "guest") return "Guest";
  return teamMemberLabel(identity.userId);
}

/**
 * Build a prompt that includes conversation history for context.
 * Keeps recent messages (last N exchanges) to avoid blowing up the prompt.
 *
 * Attachments are filtered to only include files referenced in the
 * conversation window (via [attachment:<fileName>] markers in message content).
 * - Images: referenced by path so the agent can read them (Claude Code is multimodal)
 * - Non-images: referenced by path so the agent knows where the file is
 */
function buildPromptWithHistory(
  messages: Message[],
  currentText: string,
  identity: ResolvedIdentity,
  attachments?: Attachment[],
): string {
  const parts: string[] = [];

  // Conversation history — the last HISTORY_WINDOW turns, under a shared
  // character budget.
  const recent = messages.length > 0 ? messages.slice(-HISTORY_WINDOW) : [];
  if (recent.length > 0) {
    const historyLines = renderHistoryLines(recent);

    if (historyLines.length > 0) {
      parts.push(
        "Conversation history (for context — this is a continuing conversation):\n" +
        historyLines.join("\n\n")
      );
    }
  }

  // Current message — labeled by sender so the agent sees who is speaking now
  parts.push(`New message from [${currentMessageLabel(identity)}]:\n` + currentText);

  // Filter attachments to only those referenced in the conversation window
  // or the current message. Messages store [attachment:<fileName>] markers.
  if (attachments && attachments.length > 0) {
    const windowText = recent.map((m) => m.content).join("\n") + "\n" + currentText;
    const referencedAttachments = attachments.filter((a) =>
      windowText.includes(`[attachment:${a.fileName}]`)
    );

    if (referencedAttachments.length > 0) {
      const attachmentLines = referencedAttachments.map((a) => {
        if (a.isImage) {
          return `Attached image: ${a.fileName} — saved to ${a.filePath} (read this file to view the image)`;
        }
        return `Attached file: ${a.fileName} (${a.mimeType}) — saved to ${a.filePath}`;
      });
      parts.push("Attachments:\n" + attachmentLines.join("\n"));
    }
  }

  return parts.join("\n\n---\n\n");
}
