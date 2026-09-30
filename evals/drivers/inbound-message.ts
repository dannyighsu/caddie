/**
 * Driver: an inbound message (email today) handled by a real agent run.
 *
 * Mirrors the portal's inbound path end to end — the same prompt assembly
 * (`assembleInboundPrompt`), envelope summary, identity, launcher and one-time
 * reply reminder — with the control plane faked and the agent sandboxed. What
 * isn't reproduced: DB persistence, tracing, and attachment download (a case
 * can reference `[attachment:…]` markers in text, but no file exists).
 */

import { mkdir } from "fs/promises";
import { resolve } from "path";
import { z } from "zod";
import { createLauncher, createRuntime } from "@ignis/harness";
import {
  assembleInboundPrompt,
  summarizeEnvelope,
  toRunIdentity,
  REPLY_NUDGE_PROMPT,
  needsReplyNudge,
  mergeUsage,
  type ResolvedIdentity,
  type Message,
} from "../core/portal.ts";
import type { Driver, Evidence, LoadedCase, RunOptions, SuiteConfig } from "../core/types.ts";
import { startFakePortal } from "../core/fake-portal.ts";
import { createSandbox } from "../core/sandbox.ts";
import { collectTranscript } from "../core/transcript.ts";
import { AGENT_ADDRESS, FAKE_TEAM, bare } from "../core/team.ts";

const Turn = z
  .object({
    /** `agent`, `guest`, or a team member id (`danny`, `betty`). */
    from: z.string(),
    text: z.string(),
    at: z.string().optional(),
  })
  .strict();

const InboundCase = z
  .object({
    /** Wall-clock time the run believes it is, e.g. "Wednesday, September 23, 2026 at 9:03 AM PDT". */
    now: z.string(),
    channel: z.literal("email").default("email"),
    /** Who sent the new message: a team member id, or `guest`. */
    sender: z.string().default("guest"),
    envelope: z
      .object({
        subject: z.string(),
        from: z.string(),
        to: z.array(z.string()),
        cc: z.array(z.string()).default([]),
      })
      .strict(),
    history: z.array(Turn).default([]),
    message: z.string(),
    /** Data behind the stubbed Google tools. Only faked backends can be seeded. */
    fixtures: z
      .object({
        gmail: z.array(z.unknown()).optional(),
        calendar: z.array(z.unknown()).optional(),
        /** Documents the stub search index serves, written into the workspace at `path`. Mounts `local-rag`. */
        rag: z.array(z.object({ path: z.string(), text: z.string() }).strict()).optional(),
      })
      .strict()
      .optional(),
    /** Replay the one-time "you didn't reply" reminder, as production does. */
    nudge: z.boolean().default(true),
  })
  .passthrough();
type InboundCase = z.infer<typeof InboundCase>;

function parse(c: LoadedCase, suite: SuiteConfig): InboundCase {
  const merged = { ...suite.defaults, ...c };
  const r = InboundCase.safeParse(merged);
  if (!r.success) {
    throw new Error(r.error.issues.map((i) => `${i.path.join(".") || "(case)"}: ${i.message}`).join("; "));
  }
  for (const a of c.expect) {
    const tool = "called" in a ? a.called : "every_call" in a ? a.every_call : undefined;
    if (tool && !FAKED_TOOLS.has(tool)) {
      throw new Error(`expects a call to "${tool}", which evals don't fake (faked: ${[...FAKED_TOOLS].join(", ")})`);
    }
  }
  const members = new Set(FAKE_TEAM.map((m) => m.id));
  for (const who of [r.data.sender, ...r.data.history.map((t) => t.from)]) {
    if (who !== "guest" && who !== "agent" && !members.has(who)) {
      throw new Error(`unknown speaker "${who}" (use agent, guest, or ${[...members].join(", ")})`);
    }
  }
  return r.data;
}

/**
 * Tools whose behavior an eval reproduces faithfully: the real messaging tools
 * (fake control plane) and the fixture-backed Google stubs. A case may not
 * *require* anything else — gog, the browser, Notion and web access aren't
 * faked, so a case that needs them would be grading the fake, not the agent.
 * (`not_called` on anything is fine.)
 */
const FAKED_TOOLS = new Set([
  "reply", "send_email", "email_team", "post_to_slack",
  "list_events", "create_event", "update_event", "delete_event",
  "search_emails", "get_email", "download_attachment",
  "purge_content",
  "query_documents", "read_chunk_neighbors", "list_files",
]);

/** The inbound message's identity in a case: what `purge_content` with `current: true` targets. */
const EVAL_CONVERSATION_ID = "00000000-0000-4000-8000-000000000000";

function identityFor(sender: string, rawSender: string): ResolvedIdentity {
  return sender === "guest"
    ? { kind: "guest", channel: "email", rawSender }
    : { kind: "authenticated", userId: sender, channel: "email", rawSender };
}

function toMessages(history: InboundCase["history"]): Message[] {
  return history.map((t, i) => ({
    role: t.from === "agent" ? "assistant" : "user",
    content: t.text,
    timestamp: t.at ?? new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    ...(t.from === "agent"
      ? {}
      : { sender: t.from === "guest" ? { kind: "guest" as const } : { kind: "authenticated" as const, userId: t.from } }),
  }));
}

export const inboundMessage: Driver = {
  name: "inbound-message",

  validate(c, suite) {
    parse(c, suite);
  },

  async run(c, suite, opts: RunOptions): Promise<Evidence> {
    const kase = parse(c, suite);
    const started = Date.now();
    await mkdir(opts.runDir, { recursive: true });
    await mkdir(opts.evidenceDir, { recursive: true });

    const { envelope } = kase;
    const audience = [envelope.from, ...envelope.to, ...envelope.cc].map(bare).filter((a) => a !== AGENT_ADDRESS);
    const portal = await startFakePortal([...new Set(audience)]);

    try {
      const sandbox = await createSandbox({ runDir: opts.runDir, agentId: suite.agent, fixtures: kase.fixtures });
      const identity = identityFor(kase.sender, envelope.from);
      const prompt = assembleInboundPrompt({
        messages: toMessages(kase.history),
        text: kase.message,
        identity,
        deliveryMode: "tool",
        promptContext: summarizeEnvelope({ ...envelope, self: AGENT_ADDRESS }),
      });

      const launcher = createLauncher(
        createRuntime({ options: { model: opts.model, effort: opts.effort } }),
        {
          agentsDir: sandbox.agentsDir,
          capabilitiesDir: sandbox.capabilitiesDir,
          workspaceRoot: sandbox.workspaceRoot,
        }
      );
      const launchInput = {
        agentId: suite.agent,
        identity: toRunIdentity(identity),
        prompt,
        context: { currentTime: kase.now },
        additionalEnv: {
          PORTAL_URL: portal.url,
          PATH: `${sandbox.binDir}:${process.env.PATH ?? ""}`,
          IGNIS_REPLY_TARGET: JSON.stringify({ channel: "email", externalId: `email:eval-${c.id}`, email: { messageId: `eval-${c.id}` } }),
          IGNIS_CURRENT_MESSAGE: JSON.stringify({ conversationId: EVAL_CONVERSATION_ID, seq: kase.history.length }),
        },
      };

      let result = await launcher.launch(launchInput);
      let nudged = false;
      const replies = () => portal.effects.filter((e) => e.kind === "reply").length;
      if (
        kase.nudge &&
        result.sessionId &&
        needsReplyNudge({ deliveryMode: "tool", success: result.success, sessionId: result.sessionId, repliesBefore: 0, repliesAfter: replies() })
      ) {
        nudged = true;
        const second = await launcher.launch({ ...launchInput, prompt: REPLY_NUDGE_PROMPT, sessionId: result.sessionId });
        result = { ...second, sessionId: second.sessionId || result.sessionId, usage: mergeUsage(result.usage, second.usage) };
      }

      const transcript = result.sessionId
        ? await collectTranscript(result.sessionId, resolve(opts.evidenceDir, "transcript.jsonl"))
        : { parsed: { toolCalls: [] } };

      return {
        caseId: c.id,
        trial: opts.trial,
        model: opts.model,
        success: result.success,
        error: result.error,
        sessionId: result.sessionId,
        prompt,
        toolCalls: transcript.parsed.toolCalls,
        outbound: portal.effects,
        finalText: transcript.parsed.finalText ?? result.rawText,
        nudged,
        durationMs: Date.now() - started,
        usage: result.usage,
        transcriptPath: transcript.path,
      };
    } finally {
      await portal.close();
    }
  },
};
