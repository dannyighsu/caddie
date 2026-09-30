/**
 * A stand-in for the Ignis control API (`POST /api/control`).
 *
 * The real `reply`, `email`, `email-team` and `egress` MCP servers run unchanged
 * in an eval — so the model sees production tool definitions — but their
 * `PORTAL_URL` points here. Every side effect is recorded and answered with a
 * success, and nothing leaves the machine.
 *
 * One portal per trial, on an ephemeral port, so concurrent trials never mix.
 */

import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import type { OutboundEffect } from "./types.ts";
import { bare, isTeamAddress } from "./team.ts";

export interface FakePortal {
  url: string;
  effects: OutboundEffect[];
  /** Raw request bodies, for debugging. */
  requests: { path: string; body: unknown }[];
  close(): Promise<void>;
}

/**
 * @param replyAudience who a `reply` on this run's thread reaches (the other
 *   participants), so a reply can be classified internal vs external.
 */
export async function startFakePortal(replyAudience: string[]): Promise<FakePortal> {
  const effects: OutboundEffect[] = [];
  const requests: { path: string; body: unknown }[] = [];
  let seq = 0;

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        /* keep empty */
      }
      requests.push({ path: req.url ?? "", body });
      const reply = (obj: unknown) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };

      if (req.method !== "POST" || !req.url?.startsWith("/api/control")) {
        return reply({ success: true, runs: [], data: [] });
      }

      const n = ++seq;
      const text = (v: unknown) => (typeof v === "string" ? v : "");
      const list = (v: unknown): string[] =>
        Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];

      if (body.action === "reply") {
        const to = replyAudience.map(bare);
        effects.push({
          kind: "reply",
          to,
          external: to.some((a) => !isTeamAddress(a)),
          body: text(body.message),
          raw: body,
        });
        return reply({ success: true });
      }

      if (body.action === "notify") {
        const channel = text(body.channel);
        if (channel === "email") {
          const to = [...list(body.to), ...list(body.cc), ...list(body.bcc)].map(bare);
          effects.push({
            kind: "email",
            to,
            external: to.some((a) => !isTeamAddress(a)),
            subject: text(body.subject),
            body: text(body.message) || stripHtml(text(body.html)),
            raw: body,
          });
          return reply({ success: true, threadId: `eval-thread-${n}`, messageId: `eval-msg-${n}` });
        }
        effects.push({ kind: channel === "slack" ? "slack" : "other", to: [], external: false, body: text(body.message), raw: body });
        return reply({ success: true, ts: `${n}.000` });
      }

      if (body.action === "purge") {
        // The real portal also emails the team; that notice is the tool's own,
        // not something the agent sent, so it isn't recorded as an effect.
        effects.push({ kind: "purge", to: [], external: false, body: text(body.note), raw: body });
        return reply({ success: true, purged: body.current ? "the current message" : text(body.path) });
      }

      effects.push({ kind: "other", to: [], external: false, body: "", raw: body });
      return reply({ success: true });
    });
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    effects,
    requests,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
