import { NextResponse } from "next/server";
import { createNotionMCPClient } from "@/lib/ai/notion-mcp";
import { getAppConfig } from "@/lib/config/app-config";

export async function GET() {
  try {
    const config = getAppConfig();

    if (!config.NOTION_INTERNAL_TOKEN) {
      return NextResponse.json({
        success: false,
        error: "NOTION_INTERNAL_TOKEN not configured"
      });
    }

    const userId = "default"; // or get from session
    const mcpClient = await createNotionMCPClient({ userId });

    if (!mcpClient) {
      return NextResponse.json({
        success: false,
        error: "Failed to create Notion MCP client"
      });
    }

    const tools = await mcpClient.tools();

    // Close the client after getting tools
    await mcpClient.close();

    return NextResponse.json({
      success: true,
      clientType: "Remote STDIO via SSH",
      connection: {
        type: "workspace.exec() over SSH",
        workspace: "mcp",
        host: config.CONSTELLATION_HOST,
        command: "npx -y @notionhq/notion-mcp-server"
      },
      tools: Object.keys(tools),
      toolCount: Object.keys(tools).length,
    });
  } catch (error) {
    console.error("[Notion MCP Debug] Error:", error);
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : "Unknown error"
    });
  }
}
