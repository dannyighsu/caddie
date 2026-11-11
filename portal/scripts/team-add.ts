/**
 * Add a team member from the command line, for setting up an install without a
 * browser. `make team-add` wraps this; /settings does the same and more.
 *
 *   node scripts/team-add.ts --name Alex --email alex@example.com[,alt@example.com]
 *     [--slack U0123] [--telegram 123456] [--id alex] [--owner]
 *
 * The first member added becomes the owner. A running portal keeps its own
 * copy of the roster, so restart it afterwards.
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";

process.loadEnvFile(resolve(import.meta.dirname, "..", ".env.local"));

const { values } = parseArgs({
  options: {
    name: { type: "string" },
    email: { type: "string", multiple: true },
    slack: { type: "string" },
    telegram: { type: "string" },
    id: { type: "string" },
    owner: { type: "boolean" },
  },
});

if (!values.name) {
  console.error("Usage: team-add --name <name> --email <a@x>[,<b@y>] [--slack <id>] [--telegram <id>] [--id <id>] [--owner]");
  process.exit(1);
}

const { addTeamMember, TeamRosterError } = await import("../lib/team.ts");
const { getPool } = await import("../lib/db.ts");

try {
  const member = await addTeamMember({
    id: values.id,
    name: values.name,
    emails: (values.email ?? []).flatMap((e) => e.split(",")),
    slackId: values.slack,
    telegramId: values.telegram,
    isOwner: values.owner,
  });
  console.log(`Added ${member.name} (${member.id})${member.isOwner ? " as the owner" : ""}.`);
  console.log("If the portal is running, restart it to pick this up.");
} catch (err) {
  console.error(err instanceof TeamRosterError ? err.message : err);
  process.exitCode = 1;
} finally {
  await getPool().end();
}
