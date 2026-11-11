/**
 * Turn a real inbound-email run into an anonymized case skeleton.
 *
 *   pnpm extract-case <sessionId> <case-id> [--suite email-inbound] [--agent-address addr]
 *
 * Reads the session transcript's prompt, pulls out the envelope, conversation
 * history, current time and inbound message, maps every address and phone
 * number onto fakes, and writes suites/<suite>/cases/<case-id>.yaml with an
 * empty `expect` — which fails validation until you write the expectations.
 * Review the output before committing: names and body text are kept as-is.
 */

import { readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { resolve } from "path";
import { stringify } from "yaml";
import { findTranscript } from "../core/transcript.ts";
import { Anonymizer, FAKE_TEAM, readLiveRoster, realAddressAliases, closeLiveRoster } from "../core/team.ts";
import { SUITES_DIR } from "../core/load.ts";

const SPEAKERS: Record<string, string> = Object.fromEntries([
  ["Assistant", "agent"],
  ["Guest", "guest"],
  ["User", "guest"],
  ...FAKE_TEAM.map((m) => [m.name, m.id]),
]);

export interface ExtractedPrompt {
  now?: string;
  sender: string;
  envelope: { subject: string; from: string; to: string[]; cc: string[] };
  history: { from: string; text: string }[];
  message: string;
}

/** Parse the inbound part of a run prompt (as built by assembleInboundPrompt + the launcher). */
export function parseInboundPrompt(prompt: string): ExtractedPrompt {
  const line = (label: string) => prompt.match(new RegExp(`^- ${label}: (.*)$`, "m"))?.[1]?.trim() ?? "";
  const list = (s: string) => (s && s !== "(none)" ? s.split(/,\s*/).filter(Boolean) : []);
  const now = prompt.match(/^\[Current time: ([^\]]+)\]/m)?.[1];

  const newMsg = prompt.match(/New message from \[([^\]]+)\]:\n([\s\S]*?)(?:\n\n---\n\nAttachments:[\s\S]*)?$/);
  if (!newMsg) throw new Error("no 'New message from [...]' block — is this an inbound-message run?");

  const historyBlock = prompt.match(
    /Conversation history \(for context — this is a continuing conversation\):\n([\s\S]*?)\n\n---\n\nNew message from \[/
  )?.[1];
  const history = historyBlock
    ? historyBlock
        .split(/\n\n(?=\[[A-Za-z][\w .'-]*\]: )/)
        .map((chunk) => {
          const m = chunk.match(/^\[([^\]]+)\]: ([\s\S]*)$/);
          if (!m) return { from: "guest", text: chunk };
          return { from: SPEAKERS[m[1]] ?? "guest", text: m[2] };
        })
    : [];

  return {
    now,
    sender: SPEAKERS[newMsg[1]] ?? "guest",
    envelope: { subject: line("Subject"), from: line("From"), to: list(line("To")), cc: list(line("Cc")) },
    history,
    message: newMsg[2].trim(),
  };
}

/**
 * What the run saw from Gmail and Calendar, rebuilt into fixtures so a team-tier
 * case gets the same inbox and calendar. Emails merge search hits and full
 * reads by id (full body wins); calendar events keep only the scheduling fields
 * — descriptions carry things like confirmation numbers that no case needs.
 */
export function fixturesFromTranscript(jsonl: string): { gmail?: object[]; calendar?: object[] } {
  const names = new Map<string, string>();
  const emails = new Map<string, Record<string, unknown>>();
  const events = new Map<string, Record<string, unknown>>();
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    for (const b of Array.isArray(e?.message?.content) ? e.message.content : []) {
      if (b.type === "tool_use") names.set(b.id, String(b.name).split("__").pop()!);
      if (b.type !== "tool_result") continue;
      const tool = names.get(b.tool_use_id);
      const raw = Array.isArray(b.content) ? b.content.map((c: any) => c.text ?? "").join("") : String(b.content ?? "");
      let data: any;
      try {
        data = JSON.parse(raw);
      } catch {
        continue;
      }
      if (tool === "search_emails" && Array.isArray(data)) {
        for (const m of data) {
          const prev = emails.get(m.id) ?? {};
          const { snippet, labelIds: _l, ...meta } = m;
          emails.set(m.id, { ...meta, ...prev, body: prev.body ?? snippet });
        }
      } else if (tool === "get_email" && data?.id) {
        const { labelIds: _l, attachments: _a, ...full } = data;
        emails.set(data.id, { ...(emails.get(data.id) ?? {}), ...full });
      } else if (tool === "list_events" && Array.isArray(data)) {
        for (const ev of data) {
          events.set(ev.id, { id: ev.id, summary: ev.summary, start: ev.start, end: ev.end, ...(ev.location ? { location: ev.location } : {}) });
        }
      }
    }
  }
  return {
    ...(emails.size ? { gmail: [...emails.values()] } : {}),
    ...(events.size ? { calendar: [...events.values()] } : {}),
  };
}

async function firstPrompt(transcriptPath: string): Promise<string> {
  for (const l of (await readFile(transcriptPath, "utf-8")).split("\n")) {
    if (!l.trim()) continue;
    const e = JSON.parse(l);
    if (e.type !== "user") continue;
    const c = e.message?.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      const t = c.find((b: any) => b.type === "text");
      if (t) return t.text;
    }
  }
  throw new Error("transcript has no user prompt");
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const pos: string[] = [];
  let suite = "email-inbound";
  const agentAddresses: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--suite") suite = args[++i];
    else if (args[i] === "--agent-address") agentAddresses.push(args[++i]);
    else pos.push(args[i]);
  }
  const [sessionId, caseId] = pos;
  if (!sessionId || !caseId) {
    console.error("usage: pnpm extract-case <sessionId> <case-id> [--suite s] [--agent-address addr]");
    process.exit(2);
  }

  const transcript = await findTranscript(sessionId);
  if (!transcript) throw new Error(`no transcript for session ${sessionId}`);
  const parsed = parseInboundPrompt(await firstPrompt(transcript));
  const fixtures = fixturesFromTranscript(await readFile(transcript, "utf-8"));

  const anon = new Anonymizer(realAddressAliases(await readLiveRoster(), agentAddresses));
  const a = (s: string) => anon.text(s);
  const kase = {
    id: caseId,
    title: "TODO",
    tags: [] as string[],
    source: { session: sessionId.slice(0, 8), extracted: new Date().toISOString().slice(0, 10) },
    now: parsed.now ?? "TODO",
    sender: parsed.sender,
    envelope: {
      subject: a(parsed.envelope.subject),
      from: a(parsed.envelope.from),
      to: parsed.envelope.to.map(a),
      cc: parsed.envelope.cc.map(a),
    },
    history: parsed.history.map((t) => ({ from: t.from, text: a(t.text) })),
    message: a(parsed.message),
    ...(Object.keys(fixtures).length ? { fixtures: JSON.parse(a(JSON.stringify(fixtures))) } : {}),
    expect: [],
  };

  const out = resolve(SUITES_DIR, suite, "cases", `${caseId}.yaml`);
  if (existsSync(out)) throw new Error(`${out} exists — refusing to overwrite`);
  await writeFile(out, stringify(kase, { lineWidth: 0, blockQuote: "literal" }));
  console.log(`wrote ${out}`);
  console.log(`  ${kase.history.length} history turns (${kase.history.filter((t) => t.from === "agent").length} from the agent), sender ${kase.sender}`);
  if (kase.fixtures) {
    console.log(`  fixtures: ${fixtures.gmail?.length ?? 0} emails, ${fixtures.calendar?.length ?? 0} calendar events`);
  }
  console.log(`  addresses mapped: ${anon.mapping().length}. Review names and bodies before committing.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then(closeLiveRoster)
    .catch((err) => {
      console.error((err as Error).message);
      process.exit(1);
    });
}
