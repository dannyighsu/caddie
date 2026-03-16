import { createBackendMCPClient as createAISDKClient } from "@/lib/ai/filesystems";
import { getAppConfig } from "@/lib/config/app-config";
import { createAgentBeMCPClient as createNativeClient } from "agent-backend/mcp";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const useNative = url.searchParams.get("native") === "true";

  const config = getAppConfig();

  // In development, we use local backend - show that in the response
  if (config.isDevelopment) {
    console.log("[Debug MCP] Development mode - using LOCAL backend");
    console.log("[Debug MCP] Workspace root:", config.CONSTELLATION_WORKSPACE_ROOT);

    // Use @ai-sdk/mcp wrapped client (which uses local backend in dev)
    const mcpClient = await createAISDKClient({ userId: "debug-user" });

    console.log("[Debug MCP] AI SDK MCP client created (local), fetching tools...");

    const tools = await mcpClient.tools();
    const toolNames = Object.keys(tools);

    console.log("[Debug MCP] Available tools:", toolNames);

    await mcpClient.close();

    return NextResponse.json({
      success: true,
      clientType: "ai-sdk",
      connection: {
        type: "local",
        workspace: config.CONSTELLATION_WORKSPACE,
        workspaceRoot: config.CONSTELLATION_WORKSPACE_ROOT,
      },
      tools: toolNames,
      toolCount: toolNames.length,
    });
  }

  // Production mode - use remote backend
  const mcpPort = config.CONSTELLATION_MCP_PORT ?? 3001;
  const mcpUrl = `http://${config.CONSTELLATION_HOST}:${mcpPort}`;

  console.log("[Debug MCP] Production mode - using REMOTE backend");
  console.log("[Debug MCP] Testing connection to:", mcpUrl);
  console.log("[Debug MCP] Workspace:", config.CONSTELLATION_WORKSPACE);
  console.log("[Debug MCP] Using native client:", useNative);

  if (useNative) {
    // Use native agent-backend MCP client (from @modelcontextprotocol/sdk)
    const mcpClient = await createNativeClient({
      url: mcpUrl,
      authToken: config.CONSTELLATION_MCP_TOKEN!,
      rootDir: config.CONSTELLATION_WORKSPACE_ROOT,
      scopePath: config.CONSTELLATION_WORKSPACE,
    });

    console.log("[Debug MCP] Native MCP client created, fetching tools...");

    const { tools } = await mcpClient.listTools();
    const toolNames = tools.map((t) => t.name);

    console.log("[Debug MCP] Available tools:", toolNames);

    // Try to list files
    let files = null;
    try {
      const result = await mcpClient.callTool({
        name: "list_directory",
        arguments: { path: "/" },
      });
      files = result;
    } catch (err) {
      console.log("[Debug MCP] list_directory error:", err);
    }

    await mcpClient.close();

    return NextResponse.json({
      success: true,
      clientType: "native",
      connection: {
        type: "remote",
        host: config.CONSTELLATION_HOST,
        url: mcpUrl,
        workspace: config.CONSTELLATION_WORKSPACE,
      },
      tools: toolNames,
      toolCount: toolNames.length,
      files,
    });
  } else {
    // Use @ai-sdk/mcp wrapped client
    const mcpClient = await createAISDKClient({ userId: "debug-user" });

    console.log("[Debug MCP] AI SDK MCP client created, fetching tools...");

    const tools = await mcpClient.tools();
    const toolNames = Object.keys(tools);

    console.log("[Debug MCP] Available tools:", toolNames);

    await mcpClient.close();

    return NextResponse.json({
      success: true,
      clientType: "ai-sdk",
      connection: {
        type: "remote",
        host: config.CONSTELLATION_HOST,
        url: mcpUrl,
        workspace: config.CONSTELLATION_WORKSPACE,
      },
      tools: toolNames,
      toolCount: toolNames.length,
    });
  }
}
