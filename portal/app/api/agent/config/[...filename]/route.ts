import { readFile, writeFile, unlink, mkdir, rm, lstat } from "fs/promises";
import { resolve, basename } from "path";
import { NextRequest, NextResponse } from "next/server";
import { PERSONA_FILE, SYSTEM_FILE } from "@caddie/harness";
import { workspace, agentDir, coreSkillsDir } from "@/lib/harness";

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
 * - persona:    harness/agent/{PERSONA.md,SYSTEM.md}
 * - skill:      harness/agent/.claude/skills/{skillName}/{file}
 * - core-skill: harness/skills/core/{skillName}/{file}
 * - config:     <workspace>/config/{filename}
 *
 * Skills live in the agent *definition* (not the workspace) because that's
 * what the runtime links into `.claude/skills` — see the launcher's
 * mountSkills. Writing here is what makes an edit take effect on
 * the next run.
 */
function resolveFilePath(segments: string[], category?: string): string {
  if (category === "persona") {
    const name = segments.join("/");
    if (name !== PERSONA_FILE && name !== SYSTEM_FILE) {
      throw new BadRequest(`persona files are ${PERSONA_FILE} and ${SYSTEM_FILE}`);
    }
    return resolve(agentDir, name);
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
    return resolve(agentDir, ".claude", "skills", skill, file);
  }
  // Default: config file
  const safe = basename(segments.join("/"));
  return resolve(workspace, "config", safe);
}

/** The directory holding a skill, for whole-skill operations (create/delete). */
function resolveSkillDir(segments: string[]): string {
  const skill = segments[1];
  if (segments[0] !== "skills" || !skill || !SKILL_NAME.test(skill)) {
    throw new BadRequest("invalid skill path");
  }
  return resolve(agentDir, ".claude", "skills", skill);
}

function badRequest(err: unknown): NextResponse | null {
  if (err instanceof BadRequest) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  return null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string[] }> }
) {
  const { filename } = await params;
  const category = request.nextUrl.searchParams.get("category") ?? undefined;

  let filePath: string;
  try {
    filePath = resolveFilePath(filename, category);
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
  { params }: { params: Promise<{ filename: string[] }> }
) {
  const { filename } = await params;
  const body = await request.json();
  const { content, category } = body as { content: string; category?: string };

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  let filePath: string;
  try {
    filePath = resolveFilePath(filename, category);

    if (category === "skill") {
      // Creating a new skill: its directory may not exist yet.
      await mkdir(resolveSkillDir(filename), { recursive: true });
    } else if (!category || category === "config") {
      await mkdir(resolve(workspace, "config"), { recursive: true });
    }
  } catch (err) {
    return badRequest(err) ?? NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  await writeFile(filePath, content, "utf-8");
  return NextResponse.json({ success: true, name: filename.join("/") });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ filename: string[] }> }
) {
  const { filename } = await params;
  const category = request.nextUrl.searchParams.get("category") ?? undefined;

  // Deleting a skill removes the whole skill directory — dropping only SKILL.md
  // would leave an orphaned directory that no longer registers as a skill.
  if (category === "skill") {
    let skillDir: string;
    try {
      skillDir = resolveSkillDir(filename);
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
    await unlink(resolveFilePath(filename, category));
    return NextResponse.json({ success: true });
  } catch (err) {
    return badRequest(err) ?? NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
