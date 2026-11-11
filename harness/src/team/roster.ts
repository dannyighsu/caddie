/**
 * Team Roster
 *
 * The people this instance serves. The roster itself lives in the portal's
 * Postgres (`team_members`, edited from /settings or `make team-add`); the
 * harness stays DB-free, so every function here takes the roster as an
 * argument. The launcher gets it from `LauncherConfig.team`.
 *
 * Being on the roster is what grants the team trust tier, so nothing the agent
 * runs can write it.
 */

export interface TeamMember {
  /**
   * Stable id used in stored conversation history, the portal cookie and
   * `config/team/<id>.md`. Set when the member is added and never changed.
   */
  id: string;
  /** Display name, as the agent should refer to them. */
  name: string;
  /** Addresses, lowercased. The first is the primary, used for invites. */
  emails: string[];
  slackId?: string;
  telegramId?: string;
  /** The member portal runs are attributed to and failure alerts go to. */
  isOwner: boolean;
}

/** The default id for a new member: a slug of their name. */
export function teamMemberId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The owner, or null on an install with no members yet. */
export function teamOwner(roster: TeamMember[]): TeamMember | null {
  return roster.find((m) => m.isOwner) ?? null;
}

/** Look up a member by id. Null if the id isn't on the roster. */
export function teamMember(roster: TeamMember[], id: string): TeamMember | null {
  return roster.find((m) => m.id === id) ?? null;
}

/**
 * Display name for a member id. Falls back to the id itself, so history from a
 * member who has since been removed still renders as something rather than blank.
 */
export function teamMemberLabel(roster: TeamMember[], id: string): string {
  return teamMember(roster, id)?.name ?? id;
}

/** Map from a channel identifier to member id, for sender resolution. */
export function teamLookup(
  roster: TeamMember[],
  field: "emails" | "slackId" | "telegramId"
): Map<string, string> {
  const map = new Map<string, string>();
  for (const member of roster) {
    const value = member[field];
    if (!value) continue;
    for (const key of Array.isArray(value) ? value : [value]) {
      map.set(key.toLowerCase(), member.id);
    }
  }
  return map;
}
