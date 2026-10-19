/**
 * Team Roster Settings API
 *
 * Add, edit and remove team members, and set the owner, from /settings. The
 * roster is the trust boundary — being on it grants the team tier — so no agent
 * tool calls this; the agent's own process can't reach the database either (see
 * the env allowlist in harness/src/runtime/claude-code.ts).
 *
 *   GET                                  → { members }
 *   POST   { name, id?, emails, slackId?, telegramId?, isOwner? }  add
 *   PATCH  { id, name, emails, slackId?, telegramId? }             edit
 *   PATCH  { id, makeOwner: true }                                 hand over ownership
 *   DELETE ?id=<id>                                                remove
 */

import { NextRequest, NextResponse } from "next/server";
import {
  getTeamRoster,
  addTeamMember,
  updateTeamMember,
  setTeamOwner,
  removeTeamMember,
  TeamRosterError,
} from "@/lib/team";

async function respond(fn: () => Promise<unknown>): Promise<NextResponse> {
  try {
    const member = await fn();
    return NextResponse.json({ success: true, member, members: await getTeamRoster() });
  } catch (err) {
    if (err instanceof TeamRosterError) {
      return NextResponse.json({ success: false, error: err.message }, { status: 400 });
    }
    console.error("[Team] Roster edit failed:", err);
    return NextResponse.json({ success: false, error: (err as Error).message }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ members: await getTeamRoster() });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  return respond(() =>
    addTeamMember({
      id: body.id,
      name: body.name,
      emails: body.emails,
      slackId: body.slackId,
      telegramId: body.telegramId,
      isOwner: body.isOwner === true,
    })
  );
}

export async function PATCH(request: NextRequest) {
  const body = await request.json();
  if (!body.id) return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
  if (body.makeOwner === true) return respond(() => setTeamOwner(body.id));
  return respond(() =>
    updateTeamMember(body.id, {
      name: body.name,
      emails: body.emails,
      slackId: body.slackId,
      telegramId: body.telegramId,
    })
  );
}

export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ success: false, error: "id is required" }, { status: 400 });
  return respond(() => removeTeamMember(id));
}
