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
import { defaultAgentId } from "./harness";
import { currentTimePST } from "./helpers";
import { assembleInboundPrompt, type Attachment } from "./inbound-prompt";
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
import {
  beginRun,
  finishFromResult,
  failOrchestration,
} from "./job-ledger";
import {
  REPLY_NUDGE_PROMPT,
  countAssistantTurns,
  needsReplyNudge,
  mergeUsage,
} from "./reply-check";

/**
 * Where an agent's `reply()` tool should deliver, injected into the run as
 * `IGNIS_REPLY_TARGET` so the tool (and the control API behind it) can send
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

export type { Attachment } from "./inbound-prompt";

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
  /** The job-run ledger id for this execution (for linking replays). */
  runId?: string;
}

/**
 * Process an inbound message from any channel.
 *
 * 1. Lookup or create conversation by external ID
 * 2. Create new conversations against the base agent (default profile)
 * 3. Launch agent with conversation history as context (fresh session each time)
 * 4. Persist messages
 * 5. Reply via the provided replyFn
 */
export async function handleInboundMessage(
  params: InboundMessageParams,
  opts: { replayOf?: string } = {}
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

  // Assigned once the conversation (and thus the agent) is known, right before
  // the launch. A throw before that point predates any job identity and is
  // handled by the outer catch's channel reply; it isn't ledgered.
  let runId: string | undefined;

  try {
    let conversation = await getConversationByExternalId(externalId);
    let profile: string | undefined;

    if (conversation) {
      // An existing thread keeps whatever profile it was created with, so a
      // profile chosen once (e.g. from the portal) carries across replies.
      profile = conversation.profile ?? undefined;
    } else {
      // Inbound messages always run the base agent on its default profile.
      // Profiles are an explicit choice — made from the portal or on a
      // scheduled job — never inferred from message text.
      const agentId = await defaultAgentId();
      const title = text.length > 80 ? text.substring(0, 80) + "..." : text;
      conversation = await createConversation(agentId, title, externalId, undefined);
      console.log(`[Messaging] New thread -> ${agentId}`);
    }

    // Build prompt with conversation history for continuity. Each run is a
    // fresh session — no --resume — so prior messages are prepended, tagged with
    // each turn's sender so mixed authenticated/guest threads stay attributable.
    // See ./inbound-prompt (shared with the eval runner).
    const fullPrompt = assembleInboundPrompt({
      messages: conversation.messages,
      text,
      identity,
      deliveryMode,
      promptContext,
      threadContext: conversation.thread_context,
      attachments,
    });

    // Open the ledger row before launching, with the full inbound params (minus
    // the non-serializable replyFn closure) as the replay envelope. If the
    // process dies mid-run, the reaper flips this to failed/orphaned; either
    // way the message is replayable from the portal.
    const { replyFn: _replyFn, ...serializableParams } = params;
    runId = await beginRun(
      { source: "inbound", params: serializableParams },
      {
        agentId: conversation.agent_id,
        profile,
        label: `${traceName}: ${text.substring(0, 60)}${text.length > 60 ? "..." : ""}`,
        traceId,
        replayOf: opts.replayOf,
      }
    );

    // Record the inbound turn BEFORE launching. Ordering in a conversation is
    // insertion order (messages is a JSONB array), and in "tool" mode the
    // agent's `reply()` appends its assistant turn *during* the run — so if the
    // inbound message were appended afterwards, every turn-pair would be stored
    // (and replayed into the next prompt) reversed: the answer before the
    // question. Appending here makes the guarantee explicit: a mid-run reply
    // can only land after the message that prompted it.
    //
    // The prompt above was built from the pre-append snapshot
    // (`conversation.messages`) with `text` as the current message, so this
    // does not double-render the inbound turn for this run.
    const currentSeq = await appendMessages(conversation.id, [
      {
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        sender:
          identity.kind === "authenticated"
            ? { kind: "authenticated", userId: identity.userId }
            : { kind: "guest" },
      },
    ]);

    const launcher = getLauncher();
    const launchInput = {
      agentId: conversation.agent_id,
      profile,
      identity: toRunIdentity(identity),
      prompt: fullPrompt,
      context: {
        currentTime: currentTimePST(),
        ...context,
      },
      additionalEnv: {
        IGNIS_TRACE_ID: traceId,
        // In "tool" mode, tell the agent's reply() tool which conversation it's
        // in. Injected by the harness (not agent-supplied) so replies can only
        // land in the current thread.
        ...(deliveryMode === "tool" && replyTarget
          ? { IGNIS_REPLY_TARGET: JSON.stringify(replyTarget) }
          : {}),
        // The message this run is handling — the one thing a guest run's
        // `purge_content` may remove. Injected, never agent-supplied.
        ...(currentSeq !== null
          ? { IGNIS_CURRENT_MESSAGE: JSON.stringify({ conversationId: conversation.id, seq: currentSeq }) }
          : {}),
      },
    };
    let result = await launcher.launch(launchInput);

    // In "tool" mode a run that delivered no reply leaves the sender with
    // silence (e.g. it ended its turn "waiting" on background work). Resume the
    // session once with a reminder; a second silent ending is accepted as
    // deliberate. Delivered replies are recorded as assistant turns at send
    // time, so an unchanged count means nothing went out. See ./reply-check.
    if (deliveryMode === "tool" && result.success && result.sessionId) {
      const repliesAfter = countAssistantTurns(
        (await getConversationByExternalId(externalId))?.messages ?? []
      );
      const nudge = needsReplyNudge({
        deliveryMode,
        success: result.success,
        sessionId: result.sessionId,
        repliesBefore: countAssistantTurns(conversation.messages),
        repliesAfter,
      });
      if (nudge) {
        console.log(
          `[Messaging] No reply delivered (${traceName}) — resuming session ${result.sessionId} once with a reply reminder`
        );
        const nudged = await launcher.launch({
          ...launchInput,
          prompt: REPLY_NUDGE_PROMPT,
          sessionId: result.sessionId,
          context: { ...launchInput.context, currentTime: currentTimePST() },
        });
        result = {
          ...nudged,
          sessionId: nudged.sessionId || result.sessionId,
          usage: mergeUsage(result.usage, nudged.usage),
        };
      }
    }

    const rawText = result.rawText;

    // Record the assistant turn — only in "auto" mode. In "tool" mode the
    // agent's `reply()` tool already recorded what it actually sent (via the
    // control `reply` action) *during* the run, so history mirrors the real,
    // user-visible conversation rather than the trace-only final text. The
    // inbound turn was recorded before the launch, which is what keeps those
    // mid-run appends landing after the message that prompted them.
    if (deliveryMode === "auto" && rawText) {
      await appendMessages(conversation.id, [
        {
          role: "assistant",
          content: rawText,
          timestamp: new Date().toISOString(),
        },
      ]);
    }

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

    // Record the run's outcome in the ledger — an API-layer failure returns no
    // rawText and populates `error`, and is classified apart from an agent-task
    // error so the Runs list shows why it failed.
    await finishFromResult(runId, conversation.agent_id, result);

    return {
      rawText,
      conversationId: conversation.id,
      agentId: conversation.agent_id,
      profile,
      runId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err) || "Unknown error";
    console.error(`[Messaging] Handler error (${traceName}):`, error);
    if (err instanceof Error && err.stack) {
      console.error(`[Messaging] Stack:`, err.stack);
    }

    // If the row was opened before the throw, close it as an orchestration
    // failure so the message stays visible and replayable.
    if (runId) await failOrchestration(runId, error);

    await completeTrace(traceId, { success: false, error });

    try {
      await replyFn(`Sorry, something went wrong: ${error}`);
    } catch {
      // Best effort
    }

    throw err;
  }
}

