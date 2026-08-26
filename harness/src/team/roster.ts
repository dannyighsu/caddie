/**
 * Team Roster
 *
 * The people this instance serves, read from the environment so a second
 * install can name its own people without a code change.
 *
 * Members live in lettered slots — `TEAM_MEMBER_A_*`, `TEAM_MEMBER_B_*`. Two
 * slots is what the current team needs; adding a third is adding a letter to
 * SLOTS below, nothing more. The deliberate limit is that a roster this shape
 * lives in env vars, which stops being pleasant somewhere around five people —
 * at which point this module is the only thing that has to change.
 *
 * Per slot:
 *   TEAM_MEMBER_<S>_NAME         Display name. Required — a slot without one is
 *                                treated as unused.
 *   TEAM_MEMBER_<S>_EMAIL        Comma-separated; the first is the primary and
 *                                is the address used to invite them to events.
 *   TEAM_MEMBER_<S>_SLACK_ID     Optional, for Slack sender identification.
 *   TEAM_MEMBER_<S>_TELEGRAM_ID  Optional, for Telegram sender identification.
 *   TEAM_MEMBER_<S>_ID           Optional stable id; defaults to a slug of the
 *                                name. Set it if you rename someone and want
 *                                their existing conversation history to match.
 *
 * The first configured slot is the **owner**: the member portal runs are
 * attributed to by default, and where failure alerts go.
 */

/** Slots scanned, in order. The first configured one is the owner. */
const SLOTS = ["A", "B"] as const;

export interface TeamMember {
  /** Stable id used in stored conversation history and the portal cookie. */
  id: string;
  /** Display name, as the agent should refer to them. */
  name: string;
  /** Addresses, lowercased. The first is the primary. */
  emails: string[];
  slackId?: string;
  telegramId?: string;
}

function slug(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function readSlot(env: NodeJS.ProcessEnv, slot: string): TeamMember | null {
  const name = env[`TEAM_MEMBER_${slot}_NAME`]?.trim();
  if (!name) return null; // slot unused

  const emails = (env[`TEAM_MEMBER_${slot}_EMAIL`] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  const id = env[`TEAM_MEMBER_${slot}_ID`]?.trim() || slug(name);

  return {
    id,
    name,
    emails,
    slackId: env[`TEAM_MEMBER_${slot}_SLACK_ID`]?.trim() || undefined,
    telegramId: env[`TEAM_MEMBER_${slot}_TELEGRAM_ID`]?.trim() || undefined,
  };
}

/**
 * The configured team, in slot order. Read fresh each call so tests and the
 * portal see env changes without a restart; it's a handful of string reads.
 */
export function teamRoster(env: NodeJS.ProcessEnv = process.env): TeamMember[] {
  const members: TeamMember[] = [];
  const seen = new Set<string>();
  for (const slot of SLOTS) {
    const member = readSlot(env, slot);
    if (!member) continue;
    if (seen.has(member.id)) {
      console.warn(
        `[Team] Slot ${slot} duplicates member id "${member.id}" — ignoring it. ` +
          `Set TEAM_MEMBER_${slot}_ID to something unique.`
      );
      continue;
    }
    seen.add(member.id);
    members.push(member);
  }
  return members;
}

/** The member portal runs are attributed to and failure alerts go to. */
export function teamOwner(env: NodeJS.ProcessEnv = process.env): TeamMember | null {
  return teamRoster(env)[0] ?? null;
}

/** Look up a member by id. Null if the id isn't on the current roster. */
export function teamMember(id: string, env: NodeJS.ProcessEnv = process.env): TeamMember | null {
  return teamRoster(env).find((m) => m.id === id) ?? null;
}

/**
 * Display name for a member id. Falls back to the id itself, so history written
 * before a rename still renders as something rather than blank.
 */
export function teamMemberLabel(id: string, env: NodeJS.ProcessEnv = process.env): string {
  return teamMember(id, env)?.name ?? id;
}

/** Map from a channel identifier to member id, for sender resolution. */
export function teamLookup(
  field: "emails" | "slackId" | "telegramId",
  env: NodeJS.ProcessEnv = process.env
): Map<string, string> {
  const map = new Map<string, string>();
  for (const member of teamRoster(env)) {
    const value = member[field];
    if (!value) continue;
    for (const key of Array.isArray(value) ? value : [value]) {
      map.set(key.toLowerCase(), member.id);
    }
  }
  return map;
}
