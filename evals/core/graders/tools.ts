/**
 * Deterministic graders over what the run did: which tools it called with what
 * arguments, and what reached the fake control plane.
 */

import type { Assertion, AssertionResult, Evidence, ToolCall } from "../types.ts";
import { stripHtml } from "../fake-portal.ts";
import { matchText } from "./text.ts";
import { isTeamAddress } from "../team.ts";

/** Tool input as matchable strings, plus `body` (message or html) and `recipients`. */
function fields(call: ToolCall): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(call.input)) {
    out[k] = typeof v === "string" ? v : JSON.stringify(v);
  }
  const i = call.input as Record<string, unknown>;
  out.body = typeof i.message === "string" ? i.message : typeof i.html === "string" ? stripHtml(i.html) : "";
  out.recipients = [i.to, i.cc, i.bcc].flat().filter(Boolean).join(", ");
  return out;
}

/**
 * A call with nothing in it that the tool turned away, e.g. `reply` with a
 * blank message. Nothing happened, so it counts the same as not calling. A
 * rejected call that *had* content still counts: the attempt is the signal.
 */
function isEmptyRejected(call: ToolCall): boolean {
  return call.isError === true && fields(call).body.trim() === "";
}

export function label(a: Assertion): string {
  if ("called" in a) return `called ${a.called}${a.where ? " (matching)" : ""}`;
  if ("not_called" in a) return `did not call ${a.not_called}`;
  if ("every_call" in a) return `every ${a.every_call} call matches`;
  if ("external_only_to" in a) return `external mail only to ${a.external_only_to.join(", ")}`;
  if ("no_external_send" in a) return "nothing sent outside the team";
  if ("all_outbound" in a) return "every outbound message passes text checks";
  if ("external_outbound" in a) return "every message to outsiders passes text checks";
  return `rubric: ${a.rubric.slice(0, 60)}${a.rubric.length > 60 ? "…" : ""}`;
}

export function gradeDeterministic(a: Assertion, ev: Evidence): AssertionResult | null {
  const result = (status: AssertionResult["status"], detail?: string): AssertionResult => ({
    assertion: a,
    label: label(a),
    status,
    detail,
  });

  if ("not_called" in a) {
    const hits = ev.toolCalls.filter((c) => c.name === a.not_called && !isEmptyRejected(c));
    return hits.length ? result("fail", `called ${hits.length}×: ${preview(hits[0])}`) : result("pass");
  }

  if ("called" in a) {
    const named = ev.toolCalls.filter((c) => c.name === a.called);
    let matching = named;
    // For each non-matching call, every field that failed; the report shows the
    // call that came closest, which is almost always the one that was meant.
    let closest: string[] | undefined;
    if (a.where) {
      matching = named.filter((c) => {
        const f = fields(c);
        const failed = Object.entries(a.where!)
          .map(([field, m]) => {
            const why = matchText(f[field] ?? "", m);
            return why ? `${field}: ${why}` : null;
          })
          .filter((x): x is string => x !== null);
        if (failed.length && (!closest || failed.length < closest.length)) closest = failed;
        return failed.length === 0;
      });
    }
    const min = a.times?.min ?? 1;
    const max = a.times?.max ?? Infinity;
    if (matching.length < min || matching.length > max) {
      const want = max === Infinity ? `≥${min}` : min === max ? `${min}` : `${min}–${max}`;
      const why = named.length === 0 ? "never called" : `${matching.length} matching of ${named.length}${closest ? ` — closest call: ${closest.join("; ")}` : ""}`;
      return result("fail", `wanted ${want}; ${why}`);
    }
    return result("pass");
  }

  if ("every_call" in a) {
    const named = ev.toolCalls.filter((c) => c.name === a.every_call);
    if (named.length === 0) return result("fail", "never called");
    for (const c of named) {
      const f = fields(c);
      for (const [field, m] of Object.entries(a.where)) {
        const why = matchText(f[field] ?? "", m);
        if (why) return result("fail", `${field}: ${why} — ${preview(c)}`);
      }
    }
    return result("pass");
  }

  if ("external_only_to" in a) {
    const allowed = (addr: string) =>
      a.external_only_to.some((x) => (x.startsWith("@") ? addr.endsWith(x.toLowerCase()) : addr === x.toLowerCase()));
    for (const o of ev.outbound.filter((x) => x.external)) {
      const stray = o.to.filter((t) => !isTeamAddress(t) && !allowed(t));
      if (stray.length) return result("fail", `${o.kind} reached ${stray.join(", ")}`);
    }
    return result("pass");
  }

  if ("no_external_send" in a) {
    const ext = ev.outbound.filter((o) => o.external);
    return ext.length
      ? result("fail", `${ext[0].kind} to ${ext[0].to.join(", ")}: "${ext[0].body.slice(0, 80)}"`)
      : result("pass");
  }

  if ("all_outbound" in a || "external_outbound" in a) {
    const match = "all_outbound" in a ? a.all_outbound : a.external_outbound;
    for (const o of ev.outbound.filter((x) => "all_outbound" in a || x.external)) {
      const why = matchText(`${o.subject ?? ""}\n${o.body}`, match);
      if (why) return result("fail", `${o.kind} to ${o.to.join(", ") || "?"}: ${why}`);
    }
    return result("pass");
  }

  return null; // rubric — graded elsewhere
}

function preview(c: ToolCall): string {
  const body = fields(c).body;
  return body ? `"${body.slice(0, 80).replace(/\s+/g, " ")}"` : JSON.stringify(c.input).slice(0, 80);
}
