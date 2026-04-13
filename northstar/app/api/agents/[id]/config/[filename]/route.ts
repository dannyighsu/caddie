import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { resolve, basename } from "path";
import { NextRequest, NextResponse } from "next/server";
import { workspaceRoot, agentsDir } from "@/lib/harness";

/**
 * Resolve the actual filesystem path for a file based on its category.
 *
 * - persona: harness/agents/{id}/persona.md
 * - skill:   harness/agents/{id}/.claude/skills/{skillName}/SKILL.md
 * - config:  workspace/{id}/config/{filename}
 */
function resolveFilePath(
  agentId: string,
  filename: string,
  category?: string
): string {
  if (category === "persona") {
    return resolve(agentsDir, agentId, "persona.md");
  }
  if (category === "skill" && filename.startsWith("skills/")) {
    // filename is like "skills/feed-scan/SKILL.md"
    const parts = filename.split("/");
    if (parts.length === 3) {
      return resolve(agentsDir, agentId, ".claude", "skills", parts[1], parts[2]);
    }
  }
  // Default: config file
  const safe = basename(filename);
  return resolve(workspaceRoot, agentId, "config", safe);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await params;
  const filePath = resolveFilePath(id, filename);

  try {
    const content = await readFile(filePath, "utf-8");
    return NextResponse.json({ name: filename, content });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await params;
  const body = await request.json();
  const { content, category } = body as { content: string; category?: string };

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const filePath = resolveFilePath(id, filename, category);

  // Ensure parent directory exists for config files
  if (!category || category === "config") {
    const configDir = resolve(workspaceRoot, id, "config");
    await mkdir(configDir, { recursive: true });
  }

  await writeFile(filePath, content, "utf-8");
  return NextResponse.json({ success: true, name: filename });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await params;
  const filePath = resolveFilePath(id, filename);

  try {
    await unlink(filePath);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
