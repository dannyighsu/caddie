import { createBackend } from "@/lib/ai/filesystems";
import { NextRequest, NextResponse } from "next/server";

// Path to the engagement criteria markdown file within the xmanager workspace
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

export async function GET() {
  const backend = createBackend("default");

  try {
    const scope = backend.scope("xmanager");

    try {
      const content = await scope.read(ENGAGEMENT_CRITERIA_FILENAME);
      return NextResponse.json({
        content: content.toString(),
        exists: true,
      });
    } catch (error) {
      // File doesn't exist, create it with default content
      console.log("[Settings] No existing engagement_criteria.md found, creating with default content");

      // Ensure the config directory exists
      await scope.mkdir("config");

      // Write the default content to the file
      await scope.write(ENGAGEMENT_CRITERIA_FILENAME, DEFAULT_CONTENT);

      return NextResponse.json({
        content: DEFAULT_CONTENT,
        exists: true,
      });
    }
  } catch (error) {
    console.error("[Settings] Error reading engagement criteria:", error);
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
    await scope.write(ENGAGEMENT_CRITERIA_FILENAME, content);

    console.log("[Settings] Saved engagement criteria markdown file");

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[Settings] Error saving engagement criteria:", error);
    return NextResponse.json(
      { error: "Failed to save engagement criteria" },
      { status: 500 }
    );
  } finally {
    await backend.destroy();
  }
}
