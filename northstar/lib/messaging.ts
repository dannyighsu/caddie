/**
 * Shared Messaging Handler
 *
 * Channel-agnostic logic for processing inbound messages from any platform
 * (Slack, Telegram, email, etc.). Handles classification, agent execution,
 * conversation persistence, and tracing.
 *
 * Channel-specific adapters call handleInboundMessage() with a reply function
 * and channel-specific metadata.
 */

import { getLauncher } from "./harness";
import {
  createConversation,
  getConversationByExternalId,
  appendMessages,
  type Message,
} from "./db";
import { classifyMessage } from "./classifier";
import { currentTimePST } from "./helpers";
import { renderThreadContext } from "./thread-context";
import {
  toTrustTier,
  toRunIdentity,
  type ResolvedIdentity,
} from "./identity";
import {
  createTraceId,
  createTrace,
  completeTrace,
  getTraceUrl,
  isTracingEnabled,
} from "./tracing";

/**
 * Where an agent's `reply()` tool should deliver, injected into the run as
 * `NORTHSTAR_REPLY_TARGET` so the tool (and the control API behind it) can send
 * into the *current* conversation without the agent supplying — or being able to
 * change — the target. Channel-specific handles carry what each channel needs to
 * deliver and thread correctly.
 */
export interface ReplyTarget {
  channel: "email" | "slack" | "telegram";
  /** Conversation key, e.g. `email:<threadId>` — where the assistant turn is recorded. */
  externalId: string;
  /** Email: the inbound message to reply to (preserves In-Reply-To threading). */
  email?: { messageId: string };
  /** Slack: the channel and thread to reply in. */
  slack?: { channel: string; threadTs: string };
  /** Telegram: the chat and (optionally) the message to reply to. */
  telegram?: { chatId: string; replyToMessageId?: number };
}

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

export interface InboundMessageParams {
  /** The message text (already cleaned of mention markup, etc.) */
  text: string;
  /** Channel-specific external ID, e.g. "slack:C123:ts" or "telegram:chatId" */
  externalId: string;
  /** Channel name for tracing, e.g. "slack-message" or "telegram-message" */
  traceName: string;
  /**
   * Verified sender identity produced by the channel handler's identity
   * resolver. This is a TRUSTED field — the messaging layer does not
   * re-derive or re-verify it. Profile selection (intent) stays orthogonal
   * to trust; this drives the trust tier passed to the launcher.
   */
  identity: ResolvedIdentity;
  /** Trace metadata (channel-specific context) */
  traceMetadata?: Record<string, string>;
  /**
   * Send a reply back to the originating channel. In `deliveryMode: "auto"` this
   * delivers the agent's final text. In `"tool"` mode it is used only for the
   * error path (delivering a failure notice) — normal replies go out via the
   * agent's `reply()` tool instead.
   */
  replyFn: (text: string) => Promise<void>;
  /** Optional: additional context to pass to the agent prompt */
  context?: Record<string, string>;
  /**
   * Optional per-run context block injected into the prompt just before the
   * current message (e.g. the email envelope). NOT persisted to history.
   */
  promptContext?: string;
  /**
   * How the agent's response reaches the user:
   *   - "auto" (default): the harness delivers the final text and records it as
   *     the assistant turn. Used by Slack/Telegram.
   *   - "tool": the agent must call its `reply()` tool to respond; final text is
   *     trace-only and the assistant turn is recorded at send time (by the
   *     control `reply` action), not here. Requires `replyTarget`.
   */
  deliveryMode?: "auto" | "tool";
  /** Where `reply()` delivers; required (and only used) in "tool" mode. */
  replyTarget?: ReplyTarget;
  /** Optional: file attachments, already downloaded to the workspace */
  attachments?: Attachment[];
}

export interface InboundMessageResult {
  rawText?: string;
  conversationId: string;
  agentId: string;
  profile?: string;
}

/**
 * Process an inbound message from any channel.
 *
 * 1. Lookup or create conversation by external ID
 * 2. Classify new conversations to route to the right agent/profile
 * 3. Launch agent with conversation history as context (fresh session each time)
 * 4. Persist messages
 * 5. Reply via the provided replyFn
 */
export async function handleInboundMessage(
  params: InboundMessageParams
): Promise<InboundMessageResult> {
  const {
    text,
    externalId,
    traceName,
    traceMetadata,
    replyFn,
    context,
    promptContext,
    attachments,
    identity,
    replyTarget,
  } = params;
  const deliveryMode = params.deliveryMode ?? "auto";

  const trustTier = toTrustTier(identity);

  const traceId = createTraceId();
  await createTrace(traceId, traceName, {
    ...traceMetadata,
    identityKind: identity.kind,
    identityUser: identity.kind === "authenticated" ? identity.userId : "guest",
    trustTier,
  });

  try {
    let conversation = await getConversationByExternalId(externalId);
    let profile: string | undefined;

    if (conversation) {
      profile = conversation.profile ?? undefined;
    } else {
      const classification = await classifyMessage(text);
      console.log(
        `[Messaging] Classified "${text.substring(0, 50)}..." as: ${classification.label} (${classification.confidence})`
      );

      profile = classification.profile;
      const title = text.length > 80 ? text.substring(0, 80) + "..." : text;
      conversation = await createConversation(
        classification.agentId,
        title,
        externalId,
        profile
      );

      console.log(`[Messaging] Routed to ${classification.label}`);
    }

    // Build prompt with conversation history for continuity. Each run is a
    // fresh session — no --resume — so we prepend prior messages so the agent
    // has context from previous exchanges, tagged with each turn's sender so
    // mixed authenticated/guest threads remain attributable.
    //
    // If this thread was created by one of the agent's own tasks (e.g. a
    // recurring reminder), prepend the source-task facts so the agent can trace
    // the reply back to the task and act on it (e.g. stop the reminder).
    const taskPreamble = conversation.thread_context
      ? renderThreadContext(conversation.thread_context) + "\n\n---\n\n"
      : "";
    // Make the delivery contract explicit for this run rather than leaving the
    // agent to infer it — driven by the same `deliveryMode` flag that actually
    // governs delivery, so instruction and behavior can't drift. Only emitted in
    // "tool" mode; "auto" runs (portal, Slack, Telegram) deliver the final text.
    const deliveryPreamble =
      deliveryMode === "tool"
        ? "This is an inbound-message run: respond with the `reply` tool (your final " +
          "text is not delivered), or stay silent by not calling it if no reply is " +
          "warranted.\n\n---\n\n"
        : "";
    // Channel run-context (e.g. the email envelope) sits between any task
    // preamble and the conversation history. It's prompt-only — never persisted.
    const channelPreamble = promptContext ? promptContext + "\n\n---\n\n" : "";
    const fullPrompt = taskPreamble + deliveryPreamble + channelPreamble + buildPromptWithHistory(
      conversation.messages,
      text,
      identity,
      attachments,
    );

    const launcher = getLauncher();
    const result = await launcher.launch({
      agentId: conversation.agent_id,
      profile,
      identity: toRunIdentity(identity),
      prompt: fullPrompt,
      context: {
        currentTime: currentTimePST(),
        ...context,
      },
      additionalEnv: {
        NORTHSTAR_TRACE_ID: traceId,
        // In "tool" mode, tell the agent's reply() tool which conversation it's
        // in. Injected by the harness (not agent-supplied) so replies can only
        // land in the current thread.
        ...(deliveryMode === "tool" && replyTarget
          ? { NORTHSTAR_REPLY_TARGET: JSON.stringify(replyTarget) }
          : {}),
      },
    });

    const rawText = result.rawText;

    // Record the inbound turn. The assistant turn is recorded here only in
    // "auto" mode; in "tool" mode the agent's `reply()` tool records what it
    // actually sent (via the control `reply` action), so history always mirrors
    // the real, user-visible conversation rather than the trace-only final text.
    const now = new Date().toISOString();
    const userMessage: Message = {
      role: "user",
      content: text,
      timestamp: now,
      sender:
        identity.kind === "authenticated"
          ? { kind: "authenticated", userId: identity.userId }
          : { kind: "guest" },
    };
    const newMessages: Message[] = [userMessage];
    if (deliveryMode === "auto" && rawText) {
      newMessages.push({
        role: "assistant",
        content: rawText,
        timestamp: new Date().toISOString(),
      });
    }
    await appendMessages(conversation.id, newMessages);

    // Deliver. In "auto" mode the final text IS the reply. In "tool" mode the
    // agent already delivered (or deliberately stayed silent) via `reply()`, and
    // the final text is trace-only — so we send nothing here.
    if (deliveryMode === "auto" && rawText) {
      const traceUrl = isTracingEnabled() ? getTraceUrl(traceId) : null;
      const traceLink = traceUrl ? `\n${traceUrl}` : "";
      await replyFn(rawText + traceLink);
    }

    // Reflect the run's actual outcome — an API-layer failure returns no
    // rawText and populates `error`, and must not be recorded as a success.
    // (The owner is alerted about API-layer failures via the launcher wrapper.)
    await completeTrace(traceId, {
      agentId: conversation.agent_id,
      success: result.success,
      error: result.error,
    });

    return {
      rawText,
      conversationId: conversation.id,
      agentId: conversation.agent_id,
      profile,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err) || "Unknown error";
    console.error(`[Messaging] Handler error (${traceName}):`, error);
    if (err instanceof Error && err.stack) {
      console.error(`[Messaging] Stack:`, err.stack);
    }

    await completeTrace(traceId, { success: false, error });

    try {
      await replyFn(`Sorry, something went wrong: ${error}`);
    } catch {
      // Best effort
    }

    throw err;
  }
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
function senderLabel(m: Message): string {
  if (m.role === "assistant") return "Assistant";
  if (!m.sender) return "User";
  if (m.sender.kind === "guest") return "Guest";
  return m.sender.userId === "danny" ? "Danny" : "Betty";
}

function currentMessageLabel(identity: ResolvedIdentity): string {
  if (identity.kind === "guest") return "Guest";
  return identity.userId === "danny" ? "Danny" : "Betty";
}

function buildPromptWithHistory(
  messages: Message[],
  currentText: string,
  identity: ResolvedIdentity,
  attachments?: Attachment[],
): string {
  const parts: string[] = [];

  // Conversation history — last 20 messages
  const recent = messages.length > 0 ? messages.slice(-20) : [];
  if (recent.length > 0) {
    const historyLines = recent.map((m) => {
      const label = senderLabel(m);
      const content = m.content.length > 1000
        ? m.content.substring(0, 1000) + "..."
        : m.content;
      return `[${label}]: ${content}`;
    });

    parts.push(
      "Conversation history (for context — this is a continuing conversation):\n" +
      historyLines.join("\n\n")
    );
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
