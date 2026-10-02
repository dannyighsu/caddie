import { readdir, readFile, mkdir } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { PERSONA_FILE, SYSTEM_FILE } from "@ignis/harness";
import { workspace, agentDir, coreSkillsDir } from "@/lib/harness";

interface AgentFile {
  name: string;
  content: string;
  category: "persona" | "skill" | "core-skill" | "config";
}

export async function GET() {
  const files: AgentFile[] = [];

  // 1. Persona (per install, may not exist yet) and the shared system prompt.
  for (const name of [PERSONA_FILE, SYSTEM_FILE]) {
    let content = "";
    try {
      content = await readFile(resolve(agentDir, name), "utf-8");
    } catch {
      if (name !== PERSONA_FILE) continue;
    }
    files.push({ name, content, category: "persona" });
  }

  // 2. Skills — each skill dir has a SKILL.md
  const skillsDir = resolve(agentDir, ".claude", "skills");
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

  // 2b. Core skills — part of the harness rather than this agent's definition.
  // Listed separately from the agent's own so that's visible in the UI.
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
  const configDir = resolve(workspace, "config");
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
