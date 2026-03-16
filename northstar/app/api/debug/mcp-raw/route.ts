import { NextResponse } from "next/server";
import { getAppConfig } from "@/lib/config/app-config";

export async function GET() {
  try {
    const config = getAppConfig();
    const mcpPort = config.CONSTELLATION_MCP_PORT ?? 3001;
    const mcpUrl = `http://${config.CONSTELLATION_HOST}:${mcpPort}/mcp`;

    console.log("[Debug MCP Raw] Testing direct HTTP to:", mcpUrl);

    // Send the exact same initialize request that MCP SDK would send
    const initializeRequest = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: {
          name: "debug-client",
          version: "1.0.0"
        }
      }
    };

    const body = JSON.stringify(initializeRequest);
    console.log("[Debug MCP Raw] Request body:", body);

    const response = await fetch(mcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": `Bearer ${config.CONSTELLATION_MCP_TOKEN}`,
        "X-User-ID": "debug-user",
        "X-Workspace": config.CONSTELLATION_WORKSPACE,
        "X-Workspace-Root": config.CONSTELLATION_WORKSPACE_ROOT,
      },
      body,
    });

    const responseText = await response.text();
    console.log("[Debug MCP Raw] Response status:", response.status);
    console.log("[Debug MCP Raw] Response headers:", Object.fromEntries(response.headers.entries()));
    console.log("[Debug MCP Raw] Response body:", responseText);

    let responseJson = null;
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      // Not JSON
    }

    return NextResponse.json({
      success: response.ok,
      url: mcpUrl,
      requestBody: initializeRequest,
      response: {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseJson || responseText,
      },
    });
  } catch (error) {
    console.error("[Debug MCP Raw] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      { status: 500 }
    );
  }
}
