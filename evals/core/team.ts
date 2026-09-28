/**
 * The eval's stand-in team, and the anonymizer that maps real addresses onto it.
 *
 * Committed cases never carry real addresses or phone numbers. Every run uses
 * this fake roster (exported as TEAM_MEMBER_* env so the launcher, identity
 * labels and `email_team` all agree), and the live `config/` copied into a
 * sandbox is passed through the same anonymizer so standing instructions that
 * name the team's real addresses point at the fake ones.
 */

import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

export interface FakeMember {
  slot: "A" | "B";
  id: string;
  name: string;
  email: string;
}

export const FAKE_TEAM: FakeMember[] = [
  { slot: "A", id: "danny", name: "Danny", email: "danny@team.example" },
  { slot: "B", id: "betty", name: "Betty", email: "betty@team.example" },
];

/** The agent's own inbox in every eval run. */
export const AGENT_ADDRESS = "buri@assistant.example";

export function fakeRosterEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const m of FAKE_TEAM) {
    env[`TEAM_MEMBER_${m.slot}_NAME`] = m.name;
    env[`TEAM_MEMBER_${m.slot}_EMAIL`] = m.email;
    env[`TEAM_MEMBER_${m.slot}_ID`] = m.id;
  }
  return env;
}

export function isTeamAddress(addr: string): boolean {
  const a = bare(addr);
  return a === AGENT_ADDRESS || FAKE_TEAM.some((m) => m.email === a);
}

export function bare(field: string): string {
  const m = field.match(/<([^>]+)>/);
  return (m ? m[1] : field).trim().toLowerCase();
}

// ---------------------------------------------------------------------------
// Anonymizer
// ---------------------------------------------------------------------------

/** Parse KEY=VALUE lines from an env file (no interpolation). */
function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/**
 * Real → fake address map for the install's own people, read from the live
 * roster (northstar/.env.local, overridable by process.env). Returns an empty
 * map on a clone without one, which is fine: there's no real config to scrub.
 */
export function realAddressAliases(extraAgentAddresses: string[] = []): Map<string, string> {
  const env = { ...readEnvFile(resolve(REPO_ROOT, "northstar", ".env.local")) };
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("TEAM_MEMBER_") && v && !v.endsWith(".example")) env[k] = v;
  }
  const map = new Map<string, string>();
  for (const m of FAKE_TEAM) {
    for (const addr of (env[`TEAM_MEMBER_${m.slot}_EMAIL`] ?? "").split(",")) {
      const a = addr.trim().toLowerCase();
      if (a) map.set(a, m.email);
    }
  }
  for (const a of [env.GMAIL_ADDRESS, ...extraAgentAddresses]) {
    if (a) map.set(a.trim().toLowerCase(), AGENT_ADDRESS);
  }
  return map;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// Phone-ish: 10+ digits with optional separators and country code.
const PHONE_RE = /(?<![\w/=.-])\+?\d[\d\s().-]{8,}\d(?![\w/])/g;
const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gob", "gov", "edu", "ac"]);
const FREEMAIL = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "live.com", "me.com"]);

/**
 * Extra literal replacements for things the address and phone rules can't
 * see — full names in mail headers and signatures ("Firstname Lastname" →
 * "Firstname"). Kept in a gitignored file, evals/.scrub.json, as
 * `{ "real string": "replacement" }`, because the list itself would name the
 * people it hides.
 */
export function localScrubs(): [string, string][] {
  const p = resolve(REPO_ROOT, "evals", ".scrub.json");
  if (!existsSync(p)) return [];
  const obj = JSON.parse(readFileSync(p, "utf-8")) as Record<string, string>;
  return Object.entries(obj).sort((a, b) => b[0].length - a[0].length);
}

export class Anonymizer {
  private aliases: Map<string, string>;
  private generated = new Map<string, string>();
  private personCount = 0;
  private scrubs: [string, string][];

  constructor(aliases: Map<string, string>, scrubs: [string, string][] = localScrubs()) {
    this.aliases = new Map(aliases);
    this.scrubs = scrubs;
  }

  address(addr: string): string {
    const a = addr.toLowerCase();
    if (a.endsWith(".example")) return a;
    const known = this.aliases.get(a) ?? this.generated.get(a);
    if (known) return known;
    const [local, domain] = a.split("@");
    let fake: string;
    if (FREEMAIL.has(domain)) {
      fake = `person${++this.personCount}@mail.example`;
    } else {
      // Keep the org recognizable, drop the real domain: bodas@posadas.com → bodas@posadas.example
      const labels = domain.split(".").slice(0, -1); // drop the TLD
      if (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) labels.pop(); // posadas.com.mx
      const stem = labels[labels.length - 1] ?? domain;
      fake = `${local}@${stem}.example`;
    }
    this.generated.set(a, fake);
    return fake;
  }

  text(s: string): string {
    for (const [real, fake] of this.scrubs) s = s.split(real).join(fake);
    return s
      // Mail clients greet by the inbox's local part ("Hola burihagent") — map it too.
      .replace(this.localPartRe(), (m) => (m[0] === m[0].toUpperCase() ? "Buri" : "buri"))
      .replace(/linkedin\.com\/in\/[\w-]+/gi, "linkedin.com/in/member")
      .replace(EMAIL_RE, (m) => this.address(m))
      .replace(PHONE_RE, (m) => {
        const digits = m.replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 15) return m;
        // Dates and times like 2026-09-25 don't reach 10 digits; long ids are left alone above.
        return "+1 555 0100";
      });
  }

  private localPartRe(): RegExp {
    const locals = [...this.aliases]
      .filter(([, fake]) => fake === AGENT_ADDRESS)
      .map(([real]) => real.split("@")[0])
      .filter((l) => l.length > 3);
    return locals.length ? new RegExp(`\\b(?:${locals.join("|")})\\b(?!@)`, "gi") : /(?!)/g;
  }

  /** Real → fake pairs produced so far (for the extractor's summary; never written to disk). */
  mapping(): [string, string][] {
    return [...this.aliases, ...this.generated];
  }
}
