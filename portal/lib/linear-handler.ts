/**
 * Linear Agent Session Handler
 *
 * Mentioning the app on an issue, or delegating an issue to it, opens an agent
 * session; each later message in that session is a `prompted` event. Every
 * event becomes one inbound message on the conversation `linear:<sessionId>`,
 * run through the shared messaging handler like any other channel. The agent
 * answers with `reply`, which posts a `response` activity into the session.
 *
 * Linear marks a session unresponsive if nothing comes back within 10 seconds
 * of `created`, and a run takes longer than that to start, so an ephemeral
 * thought goes out first. The next activity replaces it.
 */

import { handleInboundMessage } from "./messaging";
import { createAgentActivity, resolveLinearIdentity } from "./linear";
import {
  inboundTextOf,
  isStopSignal,
  promptContextOf,
  senderOf,
  type AgentSessionEvent,
} from "./linear-webhook";

export async function handleLinearAgentSessionEvent(event: AgentSessionEvent): Promise<void> {
  const sessionId = event.agentSession.id;
  const issue = event.agentSession.issue;

  if (event.action !== "created" && event.action !== "prompted") {
    console.log(`[Linear Handler] Ignoring agent session action "${event.action}" session=${sessionId}`);
    return;
  }

  if (isStopSignal(event)) {
    // A run can't be interrupted from here, so say so rather than claim it stopped.
    await createAgentActivity(sessionId, {
      type: "response",
      body:
        "Stop received. I can't interrupt a run that's already going, so anything in progress will finish, " +
        "but I won't start anything new in this session until you message me again.",
    }).catch((err) => console.error("[Linear Handler] Failed to acknowledge stop:", err));
    return;
  }

  await createAgentActivity(
    sessionId,
    { type: "thought", body: event.action === "created" ? "Reading the issue…" : "Reading your message…" },
    { ephemeral: true },
  ).catch((err) => console.error("[Linear Handler] Failed to acknowledge session:", err));

  const identity = resolveLinearIdentity(senderOf(event));
  const text = inboundTextOf(event);
  const externalId = `linear:${sessionId}`;
  console.log(
    `[Linear Handler] ${event.action} session=${sessionId} issue=${issue?.identifier ?? "-"} ` +
      `identity=${identity.kind}${identity.kind === "authenticated" ? `:${identity.userId}` : ""}`,
  );

  await handleInboundMessage({
    text,
    externalId,
    traceName: "linear-session",
    identity,
    traceMetadata: {
      sessionId,
      action: event.action,
      ...(issue ? { issue: issue.identifier } : {}),
      text: text.substring(0, 100),
    },
    context: { originChannel: "linear" },
    promptContext: promptContextOf(event),
    deliveryMode: "tool",
    replyTarget: { channel: "linear", externalId, linear: { agentSessionId: sessionId } },
    // Used only for the error-notice path in tool mode.
    replyFn: async (replyText) => {
      await createAgentActivity(sessionId, { type: "error", body: replyText });
    },
  });
}
