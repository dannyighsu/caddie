import { readFile, writeFile, unlink, mkdir, rm, lstat } from "fs/promises";
import { resolve, basename } from "path";
import { NextRequest, NextResponse } from "next/server";
import { workspaceRoot, agentsDir, coreSkillsDir } from "@/lib/harness";

/**
 * Catch-all so multi-segment names round-trip: a skill file is addressed as
 * `skills/<skill>/SKILL.md`, which is three path segments.
 */

/** A skill directory name: lowercase-ish slug, no separators, no traversal. */
const SKILL_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
/** A file inside a skill directory. */
const SKILL_FILE = /^[a-z0-9][a-z0-9._-]*$/i;

class BadRequest extends Error {}

/**
 * Resolve the actual filesystem path for a file based on its category.
 *
 * - persona: harness/agents/{id}/persona.md
 * - skill:      harness/agents/{id}/.claude/skills/{skillName}/{file}
 * - core-skill: harness/skills/core/{skillName}/{file} — shared by every agent
 * - config:  workspace/{id}/config/{filename}
 *
 * Skills live in the agent *definition* (not the workspace) because that's the
 * symlink target the runtime mounts at `.claude/skills` — see the launcher's
 * ensureDefinitionSymlink. Writing here is what makes an edit take effect on
 * the next run.
 */
function resolveFilePath(
  agentId: string,
  segments: string[],
  category?: string
): string {
  if (category === "persona") {
    return resolve(agentsDir, agentId, "persona.md");
  }
  if (category === "core-skill") {
    const [prefix, skill, file] = segments;
    if (prefix !== "core-skills" || segments.length !== 3) {
      throw new BadRequest("core skill paths must be core-skills/<name>/<file>");
    }
    if (!SKILL_NAME.test(skill) || !SKILL_FILE.test(file)) {
      throw new BadRequest("invalid skill name or file name");
    }
    return resolve(coreSkillsDir, skill, file);
  }
  if (category === "skill") {
    // segments is like ["skills", "feed-scan", "SKILL.md"]
    const [prefix, skill, file] = segments;
    if (prefix !== "skills" || segments.length !== 3) {
      throw new BadRequest("skill paths must be skills/<name>/<file>");
    }
    if (!SKILL_NAME.test(skill) || !SKILL_FILE.test(file)) {
      throw new BadRequest("invalid skill name or file name");
    }
    return resolve(agentsDir, agentId, ".claude", "skills", skill, file);
  }
  // Default: config file
  const safe = basename(segments.join("/"));
  return resolve(workspaceRoot, agentId, "config", safe);
}

/** The directory holding a skill, for whole-skill operations (create/delete). */
function resolveSkillDir(agentId: string, segments: string[]): string {
  const skill = segments[1];
  if (segments[0] !== "skills" || !skill || !SKILL_NAME.test(skill)) {
    throw new BadRequest("invalid skill path");
  }
  return resolve(agentsDir, agentId, ".claude", "skills", skill);
}

function badRequest(err: unknown): NextResponse | null {
  if (err instanceof BadRequest) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string[] }> }
) {
  const { id, filename } = await params;
  const category = request.nextUrl.searchParams.get("category") ?? undefined;

  let filePath: string;
  try {
    filePath = resolveFilePath(id, filename, category);
  } catch (err) {
    return badRequest(err) ?? NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  try {
    const content = await readFile(filePath, "utf-8");
    return NextResponse.json({ name: filename.join("/"), content });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string[] }> }
) {
  const { id, filename } = await params;
  const body = await request.json();
  const { content, category } = body as { content: string; category?: string };

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  let filePath: string;
  try {
    filePath = resolveFilePath(id, filename, category);

    if (category === "skill") {
      // Creating a new skill: its directory may not exist yet.
      await mkdir(resolveSkillDir(id, filename), { recursive: true });
    } else if (!category || category === "config") {
      await mkdir(resolve(workspaceRoot, id, "config"), { recursive: true });
    }
  } catch (err) {
    return badRequest(err) ?? NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  await writeFile(filePath, content, "utf-8");
  return NextResponse.json({ success: true, name: filename.join("/") });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string[] }> }
) {
  const { id, filename } = await params;
  const category = request.nextUrl.searchParams.get("category") ?? undefined;

  // Deleting a skill removes the whole skill directory — dropping only SKILL.md
  // would leave an orphaned directory that no longer registers as a skill.
  if (category === "skill") {
    let skillDir: string;
    try {
      skillDir = resolveSkillDir(id, filename);
    } catch (err) {
      return badRequest(err) ?? NextResponse.json({ error: "Bad request" }, { status: 400 });
    }
    try {
      await lstat(skillDir);
    } catch {
      return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    }
    await rm(skillDir, { recursive: true, force: true });
    return NextResponse.json({ success: true });
  }

  try {
    await unlink(resolveFilePath(id, filename, category));
    return NextResponse.json({ success: true });
  } catch (err) {
    return badRequest(err) ?? NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
