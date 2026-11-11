/**
 * Team Roster — the portal's copy
 *
 * The people this install serves, stored in the `team_members` table. This
 * module is the only thing that writes it, and it's reachable only from the
 * settings UI (`/api/settings/team`) and `make team-add`: the agent gets no tool
 * for it, because being on the roster is what grants the team trust tier.
 *
 * Sender resolution runs synchronously all over the portal (email, Slack,
 * Telegram, identity labels), so reads go through an in-memory copy loaded at
 * startup and refreshed after every write. `teamRoster()` throws until that
 * first load lands rather than returning an empty team, which would quietly
 * treat every team member as a guest; instrumentation holds the channel
 * listeners until it has.
 */

import type { PoolClient } from "pg";
import { teamMemberId, teamOwner, type TeamMember } from "@caddie/harness";
import { ensureSchema, getPool } from "./db.ts";

/** A rejected roster edit, with a message fit to show the person making it. */
export class TeamRosterError extends Error {}

// --- Cache ---
//
// On globalThis rather than module scope: Next.js bundles instrumentation and
// route handlers separately, so a module-level copy would leave the Slack and
// Gmail listeners on a stale roster after a /settings edit.

interface Cache {
  members: TeamMember[] | null;
  loading: Promise<TeamMember[]> | null;
}

function cache(): Cache {
  const g = globalThis as { __caddieTeamRoster?: Cache };
  g.__caddieTeamRoster ??= { members: null, loading: null };
  return g.__caddieTeamRoster;
}

/**
 * The current roster, owner first. Throws if it hasn't been loaded yet (the
 * database was unreachable at startup); that also starts a load, so a retried
 * request will find it.
 */
export function teamRoster(): TeamMember[] {
  const c = cache();
  if (c.members) return c.members;
  loadTeamRoster().catch(() => {}); // logged by the caller that awaits it
  throw new Error("[Team] Roster not loaded yet — is Postgres reachable?");
}

/** The roster, loading it first if needed. For callers that can await. */
export async function getTeamRoster(): Promise<TeamMember[]> {
  return cache().members ?? loadTeamRoster();
}

/**
 * Read the roster straight from the database, leaving the cache alone. The
 * evals use this to scrub real addresses while the cache holds their fake team.
 */
export async function readTeamRoster(): Promise<TeamMember[]> {
  await ensureSchema();
  const { rows } = await getPool().query(
    `SELECT * FROM team_members ORDER BY is_owner DESC, created_at, id`
  );
  return rows.map(rowToMember);
}

/** Read the roster from the database into the cache. Concurrent calls share one query. */
export function loadTeamRoster(): Promise<TeamMember[]> {
  const c = cache();
  c.loading ??= (async () => {
    try {
      c.members = await readTeamRoster();
      return c.members;
    } finally {
      c.loading = null;
    }
  })();
  return c.loading;
}

/**
 * Load the roster, retrying with backoff until Postgres answers. Startup awaits
 * this before starting anything that resolves senders.
 */
export async function waitForTeamRoster(): Promise<TeamMember[]> {
  for (let delay = 1000; ; delay = Math.min(delay * 2, 30_000)) {
    try {
      const members = await loadTeamRoster();
      if (members.length === 0) {
        console.warn("[Team] The roster is empty — add the owner at /settings or with `make team-add`.");
      } else if (!teamOwner(members)) {
        console.warn("[Team] No member is the owner — failure alerts have nowhere to go.");
      }
      return members;
    } catch (err) {
      console.error(
        `[Team] Couldn't load the roster (${(err as Error).message}); ` +
          `retrying in ${delay / 1000}s. Channel listeners wait for it.`
      );
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Set the cached roster directly, bypassing the database. For evals and tests. */
export function primeTeamRoster(members: TeamMember[]): void {
  cache().members = members;
}

// --- Writes ---

export interface TeamMemberInput {
  name: string;
  /** Any case, any order of whitespace; the first is the primary. */
  emails?: string[];
  slackId?: string | null;
  telegramId?: string | null;
}

/**
 * Add a member. The id is a slug of the name unless given, and is fixed from
 * here on. The first member added becomes the owner.
 */
export async function addTeamMember(
  input: TeamMemberInput & { id?: string; isOwner?: boolean }
): Promise<TeamMember> {
  const fields = normalize(input);
  const id = (input.id?.trim() || teamMemberId(fields.name)).toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
    throw new TeamRosterError(
      `"${id}" can't be an id — use lowercase letters, digits and single hyphens.`
    );
  }

  return write(async (client) => {
    if ((await client.query(`SELECT 1 FROM team_members WHERE id = $1`, [id])).rowCount) {
      throw new TeamRosterError(
        `There's already a member with id "${id}". Pick a different id.`
      );
    }
    await assertUnique(client, id, fields);
    const { rowCount: others } = await client.query(`SELECT 1 FROM team_members`);
    const isOwner = input.isOwner === true || !others;
    if (isOwner) await client.query(`UPDATE team_members SET is_owner = false WHERE is_owner`);
    await client.query(
      `INSERT INTO team_members (id, name, emails, slack_id, telegram_id, is_owner)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, fields.name, fields.emails, fields.slackId, fields.telegramId, isOwner]
    );
    return id;
  });
}

/** Change a member's name or channel identifiers. The id can't change. */
export async function updateTeamMember(id: string, input: TeamMemberInput): Promise<TeamMember> {
  const fields = normalize(input);
  return write(async (client) => {
    await assertUnique(client, id, fields);
    const { rowCount } = await client.query(
      `UPDATE team_members
       SET name = $2, emails = $3, slack_id = $4, telegram_id = $5, updated_at = now()
       WHERE id = $1`,
      [id, fields.name, fields.emails, fields.slackId, fields.telegramId]
    );
    if (!rowCount) throw new TeamRosterError(`No member with id "${id}".`);
    return id;
  });
}

/** Make `id` the owner, taking it from whoever held it. */
export async function setTeamOwner(id: string): Promise<TeamMember> {
  return write(async (client) => {
    if (!(await client.query(`SELECT 1 FROM team_members WHERE id = $1`, [id])).rowCount) {
      throw new TeamRosterError(`No member with id "${id}".`);
    }
    await client.query(`UPDATE team_members SET is_owner = false, updated_at = now() WHERE is_owner`);
    await client.query(`UPDATE team_members SET is_owner = true, updated_at = now() WHERE id = $1`, [id]);
    return id;
  });
}

/**
 * Remove a member. The owner can't be removed — hand ownership to someone else
 * first — so the install always has somewhere to send failure alerts. Their
 * history keeps the raw id, and their `config/team/<id>.md` stays in the
 * workspace for the agent's owner to tidy.
 */
export async function removeTeamMember(id: string): Promise<void> {
  await write(async (client) => {
    const { rows } = await client.query(`SELECT is_owner FROM team_members WHERE id = $1`, [id]);
    if (!rows.length) throw new TeamRosterError(`No member with id "${id}".`);
    if (rows[0].is_owner) {
      throw new TeamRosterError("The owner can't be removed. Make someone else the owner first.");
    }
    await client.query(`DELETE FROM team_members WHERE id = $1`, [id]);
    return id;
  });
}

// --- Internals ---

interface NormalizedFields {
  name: string;
  emails: string[];
  slackId: string | null;
  telegramId: string | null;
}

function normalize(input: TeamMemberInput): NormalizedFields {
  const name = input.name?.trim();
  if (!name) throw new TeamRosterError("A name is required.");
  const emails = [
    ...new Set((input.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ];
  const bad = emails.find((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  if (bad) throw new TeamRosterError(`"${bad}" isn't an email address.`);
  return {
    name,
    emails,
    slackId: input.slackId?.trim() || null,
    telegramId: input.telegramId?.trim() || null,
  };
}

/**
 * Every email, Slack id and Telegram id resolves a sender to exactly one
 * member, so none may belong to two. Runs under the table lock `write` takes,
 * so two concurrent edits can't both pass.
 */
async function assertUnique(client: PoolClient, id: string, f: NormalizedFields): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, name, emails, slack_id, telegram_id FROM team_members WHERE id <> $1`,
    [id]
  );
  for (const other of rows) {
    const email = f.emails.find((e) => (other.emails as string[]).includes(e));
    if (email) throw new TeamRosterError(`${email} already belongs to ${other.name}.`);
    if (f.slackId && other.slack_id === f.slackId) {
      throw new TeamRosterError(`Slack id ${f.slackId} already belongs to ${other.name}.`);
    }
    if (f.telegramId && other.telegram_id === f.telegramId) {
      throw new TeamRosterError(`Telegram id ${f.telegramId} already belongs to ${other.name}.`);
    }
  }
}

/** Run a roster edit in a locked transaction, then refresh the cache. Returns the edited member. */
async function write(edit: (client: PoolClient) => Promise<string>): Promise<TeamMember> {
  await ensureSchema();
  const client = await getPool().connect();
  let id: string;
  try {
    await client.query("BEGIN");
    await client.query("LOCK TABLE team_members IN SHARE ROW EXCLUSIVE MODE");
    id = await edit(client);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // A load already in flight may have read before the commit; wait it out so
  // the one we start sees the edit.
  await cache().loading?.catch(() => {});
  const members = await loadTeamRoster();
  return members.find((m) => m.id === id) ?? ({ id } as TeamMember);
}

function rowToMember(row: Record<string, unknown>): TeamMember {
  return {
    id: row.id as string,
    name: row.name as string,
    emails: row.emails as string[],
    slackId: (row.slack_id as string | null) ?? undefined,
    telegramId: (row.telegram_id as string | null) ?? undefined,
    isOwner: row.is_owner as boolean,
  };
}
