import { readFile, writeFile, mkdir } from "fs/promises";
import { resolve, dirname } from "path";
import { NextRequest, NextResponse } from "next/server";
import { getAppConfig } from "@/lib/config/app-config";

const ENGAGEMENT_CRITERIA_FILENAME = "config/engagement_criteria.md";

const DEFAULT_CONTENT = `### Reply Prioritization Criteria

Include all replies that are made directly to you, except:
- Simple acknowledgments ("great post!", "thanks!", etc.)
- Emoji-only responses
- Spam or promotional content
- Hostile or bad-faith engagement
- Low-effort responses that don't warrant a reply

### Feed Opportunity Criteria

Include posts that match ALL of these:
1. **Topic Relevance**: Within the areas of interest
2. **Engagement Timing**: Posted within the last <6 hours (optimal engagement window)
3. **Thread Potential**: Has potential for meaningful conversation or valuable contribution
4. **Quality Standard**: Well-written, thought-provoking content worth engaging with

Prioritize posts from:
- Accounts you frequently engage with (relationship building)
- Rising voices in your network (early engagement)
- Posts with growing engagement but room for quality replies

### Performance Analysis Criteria

When analyzing your recent posts and replies, track:
- Impressions
- Like-to-reply ratio (higher ratio = resonant content)
- Whether the post sparked further conversation

Flag successful patterns to learn from:
- Topics that consistently resonate
- Reply formats that perform well (questions, hot takes, expertise sharing)
- Optimal posting times based on engagement
- Types of threads that benefit most from your participation`;

function getFilePath(): string {
  const config = getAppConfig();
  const workspaceRoot = config.WORKSPACE_ROOT ?? resolve(process.cwd(), "workspace");
  return resolve(workspaceRoot, "default", "xmanager", ENGAGEMENT_CRITERIA_FILENAME);
}

export async function GET() {
  const filePath = getFilePath();

  try {
    const content = await readFile(filePath, "utf-8");
    return NextResponse.json({ content, exists: true });
  } catch {
    console.log("[Settings] No existing engagement_criteria.md found, creating with default content");
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

    console.log("[Settings] Saved engagement criteria markdown file");
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Settings] Error saving engagement criteria:", error);
    return NextResponse.json(
      { error: "Failed to save engagement criteria" },
      { status: 500 }
    );
  }
}
