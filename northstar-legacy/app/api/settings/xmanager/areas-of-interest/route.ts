import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { NextRequest, NextResponse } from "next/server";
import { getAppConfig } from "@/lib/config/app-config";

const AREAS_OF_INTEREST_FILENAME = "config/areas_of_interest.md";

const DEFAULT_CONTENT = `# Areas of Interest

Your company is an AI agent consultancy and SaaS solutions creator targeting engineering productivity and AI agent reliability.

## Topic Areas

- Software engineering productivity
- Startups
- SaaS solutions
- AI agents
- UI/UX design in software
`;

function getFilePath(): string {
  const config = getAppConfig();
  const workspaceRoot = config.WORKSPACE_ROOT ?? resolve(process.cwd(), "workspace");
  return resolve(workspaceRoot, "default", "xmanager", AREAS_OF_INTEREST_FILENAME);
}

export async function GET() {
  const filePath = getFilePath();

  try {
    const content = await readFile(filePath, "utf-8");
    return NextResponse.json({ content, exists: true });
  } catch {
    // File doesn't exist, create it with default content
    console.log("[Settings] No existing areas_of_interest.md found, creating with default content");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, DEFAULT_CONTENT);
    return NextResponse.json({ content: DEFAULT_CONTENT, exists: true });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { content } = body;

    if (typeof content !== "string") {
      return NextResponse.json(
        { error: "content must be a string" },
        { status: 400 }
      );
    }

    const filePath = getFilePath();
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content);

    console.log("[Settings] Saved areas of interest markdown file");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Settings] Error saving areas of interest:", error);
    return NextResponse.json(
      { error: "Failed to save areas of interest" },
      { status: 500 }
    );
  }
}
