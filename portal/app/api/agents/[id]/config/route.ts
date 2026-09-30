import { readdir, readFile, mkdir } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { workspaceRoot, agentsDir, coreSkillsDir } from "@/lib/harness";

interface AgentFile {
  name: string;
  content: string;
  category: "persona" | "skill" | "core-skill" | "config";
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const files: AgentFile[] = [];

  // 1. Persona
  const personaPath = resolve(agentsDir, id, "persona.md");
  try {
    const content = await readFile(personaPath, "utf-8");
    files.push({ name: "persona.md", content, category: "persona" });
  } catch {
    // No persona file
  }

  // 2. Skills — each skill dir has a SKILL.md
  const skillsDir = resolve(agentsDir, id, ".claude", "skills");
  try {
    const skillEntries = await readdir(skillsDir, { withFileTypes: true });
    for (const entry of skillEntries) {
      if (!entry.isDirectory()) continue;
      const skillFile = resolve(skillsDir, entry.name, "SKILL.md");
      try {
        const content = await readFile(skillFile, "utf-8");
        files.push({
          name: `skills/${entry.name}/SKILL.md`,
          content,
          category: "skill",
        });
      } catch {
        // Skill dir without SKILL.md
      }
    }
  } catch {
    // No skills directory
  }

  // 2b. Core skills — shared by every agent, so an edit here lands for all of
  // them. Listed separately from the agent's own so that's visible in the UI.
  try {
    const coreEntries = await readdir(coreSkillsDir, { withFileTypes: true });
    for (const entry of coreEntries) {
      if (!entry.isDirectory()) continue;
      try {
        const content = await readFile(
          resolve(coreSkillsDir, entry.name, "SKILL.md"),
          "utf-8"
        );
        files.push({
          name: `core-skills/${entry.name}/SKILL.md`,
          content,
          category: "core-skill",
        });
      } catch {
        // Skill dir without SKILL.md
      }
    }
  } catch {
    // No core skills directory
  }

  // 3. Config files (from workspace)
  const configDir = resolve(workspaceRoot, id, "config");
  try {
    await mkdir(configDir, { recursive: true });
    const entries = await readdir(configDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const content = await readFile(resolve(configDir, entry.name), "utf-8");
      files.push({ name: entry.name, content, category: "config" });
    }
  } catch {
    // No config dir
  }

  return NextResponse.json(files);
}
