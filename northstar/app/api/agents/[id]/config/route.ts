import { readdir, readFile, mkdir } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { workspaceRoot } from "@/lib/harness";

function getConfigDir(agentId: string): string {
  return resolve(workspaceRoot, agentId, "config");
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const configDir = getConfigDir(id);

  try {
    await mkdir(configDir, { recursive: true });
    const entries = await readdir(configDir, { withFileTypes: true });
    const files: { name: string; content: string }[] = [];

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const content = await readFile(resolve(configDir, entry.name), "utf-8");
      files.push({ name: entry.name, content });
    }

    return NextResponse.json(files);
  } catch {
    return NextResponse.json([]);
  }
}
