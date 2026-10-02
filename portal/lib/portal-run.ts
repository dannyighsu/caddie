/**
 * Portal Agent Run
 *
 * The shared execution path for a manual "run now" from the owner console.
 * Extracted from the run route so both the route and the job-run ledger's
 * replay path drive the exact same logic: resolve/create the conversation,
 * ledger the run, launch, persist messages, and record the session id.
 */

import { getLauncher } from "./harness";
import {
  createConversation,
  getConversation,
  appendMessages,
  updateSessionId,
  type Message,
} from "./db";
import { currentTimePST } from "./helpers";
import {
  portalIdentity,
  toRunIdentity,
  type UserId,
} from "./identity";
import { beginRun, finishFromResult, failOrchestration } from "./job-ledger";

/** Serializable inputs for a portal run — the replay envelope's `portal` variant. */
export interface PortalRunInput {
  prompt: string;
  profile?: string;
  /** Team owner the run is attributed to. */
  portalOwner: UserId;
  /** Extra persona/template context (currentTime is added if absent). */
  context?: Record<string, string>;
  /** Existing conversation to continue, if any. */
  conversationId?: string;
}

export interface PortalRunResult {
  success: boolean;
  conversationId: string;
  sessionId: string;
  rawText: string;
  output: Record<string, unknown> | null;
  error?: string;
  /** The ledger run id for this execution. */
  runId: string;
}

/**
 * Run the agent from the portal. Ledgers the execution (so a failure is
 * replayable) and returns the launch outcome. Throws only on setup errors
 * (e.g. a missing conversation) — a failed agent run returns success: false.
 */
export async function runPortalAgent(
  input: PortalRunInput,
  opts: { replayOf?: string } = {}
): Promise<PortalRunResult> {
  const resolvedContext: Record<string, string> = {
    currentTime: currentTimePST(),
    ...input.context,
  };

  // Resolve or create the conversation up front so a failure still has a home.
  let conversation;
  let sessionId: string | undefined;
  if (input.conversationId) {
    conversation = await getConversation(input.conversationId);
    if (!conversation) {
      throw new Error(`Conversation ${input.conversationId} not found`);
    }
    sessionId = conversation.session_id ?? undefined;
  } else {
    const title =
      input.prompt.length > 80 ? input.prompt.substring(0, 80) + "..." : input.prompt;
    conversation = await createConversation(title, undefined, input.profile);
  }

  const label = `${input.profile ?? "default"} — ${
    input.prompt.length > 60 ? input.prompt.substring(0, 60) + "..." : input.prompt
  }`;

  const runId = await beginRun(
    { source: "portal", input },
    {
      profile: input.profile,
      label,
      replayOf: opts.replayOf,
    }
  );

  try {
    const launcher = getLauncher();
    const result = await launcher.launch({
      profile: input.profile,
      identity: toRunIdentity(portalIdentity(input.portalOwner)),
      prompt: input.prompt,
      sessionId,
      context: resolvedContext,
    });

    const now = new Date().toISOString();
    const newMessages: Message[] = [
      {
        role: "user",
        content: input.prompt,
        timestamp: now,
        sender: { kind: "authenticated", userId: input.portalOwner },
      },
    ];
    if (result.rawText) {
      newMessages.push({
        role: "assistant",
        content: result.rawText,
        timestamp: new Date().toISOString(),
      });
    }
    await appendMessages(conversation.id, newMessages);

    if (result.sessionId) {
      await updateSessionId(conversation.id, result.sessionId);
    }

    await finishFromResult(runId, result);

    return {
      success: result.success,
      conversationId: conversation.id,
      sessionId: result.sessionId,
      rawText: result.rawText,
      output: result.output,
      error: result.error,
      runId,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Unknown error";
    await failOrchestration(runId, error);
    throw err;
  }
}
