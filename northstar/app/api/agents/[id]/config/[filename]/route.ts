import { readFile, writeFile, unlink, mkdir } from "fs/promises";
import { resolve, basename } from "path";
import { NextRequest, NextResponse } from "next/server";
import { workspaceRoot } from "@/lib/harness";

function getConfigPath(agentId: string, filename: string): string {
  const safe = basename(filename);
  return resolve(workspaceRoot, agentId, "config", safe);
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await params;
  const filePath = getConfigPath(id, filename);

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
  const filePath = getConfigPath(id, filename);
  const body = await request.json();
  const { content } = body as { content: string };

  if (typeof content !== "string") {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }

  const configDir = resolve(workspaceRoot, id, "config");
  await mkdir(configDir, { recursive: true });

  await writeFile(filePath, content, "utf-8");
  return NextResponse.json({ success: true, name: filename });
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; filename: string }> }
) {
  const { id, filename } = await params;
  const filePath = getConfigPath(id, filename);

  try {
    await unlink(filePath);
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
}
