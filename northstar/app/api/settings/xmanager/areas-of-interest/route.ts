import { createBackend } from "@/lib/ai/filesystems";
import { NextRequest, NextResponse } from "next/server";

// Path to the areas of interest markdown file within the xmanager workspace
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

export async function GET() {
  const backend = createBackend("default");

  try {
    const scope = backend.scope("xmanager");

    try {
      const content = await scope.read(AREAS_OF_INTEREST_FILENAME);
      return NextResponse.json({
        content: content.toString(),
        exists: true,
      });
    } catch (error) {
      // File doesn't exist, create it with default content
      console.log("[Settings] No existing areas_of_interest.md found, creating with default content");

      // Ensure the config directory exists
      await scope.mkdir("config");

      // Write the default content to the file
      await scope.write(AREAS_OF_INTEREST_FILENAME, DEFAULT_CONTENT);

      return NextResponse.json({
        content: DEFAULT_CONTENT,
        exists: true,
      });
    }
  } catch (error) {
    console.error("[Settings] Error reading areas of interest:", error);
    // Return default content on error (but don't mark as exists)
    return NextResponse.json({
      content: DEFAULT_CONTENT,
      exists: false,
    });
  } finally {
    await backend.destroy();
  }
}

export async function POST(request: NextRequest) {
  const backend = createBackend("default");

  try {
    const body = await request.json();
    const { content } = body;

    if (typeof content !== "string") {
      return NextResponse.json(
        { error: "content must be a string" },
        { status: 400 }
      );
    }

    const scope = backend.scope("xmanager");

    // Ensure the config directory exists
    await scope.mkdir("config");

    // Write the markdown file
    await scope.write(AREAS_OF_INTEREST_FILENAME, content);

    console.log("[Settings] Saved areas of interest markdown file");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Settings] Error saving areas of interest:", error);
    return NextResponse.json(
      { error: "Failed to save areas of interest" },
      { status: 500 }
    );
  } finally {
    await backend.destroy();
  }
}
