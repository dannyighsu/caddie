import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAppConfig } from "../config/app-config";

export interface WebSearchMCPClientOptions {
  provider?: "brave" | "tavily" | "serpapi";
}

/**
 * Create an MCP client for web search tools.
 *
 * Supports multiple search providers via MCP:
 * - Brave Search: Requires BRAVE_SEARCH_API_KEY
 * - Tavily: Requires TAVILY_API_KEY
 * - SerpAPI: Requires SERPAPI_API_KEY
 *
 * The provider can be configured via WEB_SEARCH_PROVIDER env var.
 * Falls back to creating tools without MCP if no provider is configured.
 */
export async function createWebSearchMCPClient(
  options: WebSearchMCPClientOptions = {}
) {
  const config = getAppConfig();
  const provider = options.provider || config.WEB_SEARCH_PROVIDER || "brave";

  console.log(`[Web Search MCP] Creating client for provider: ${provider}`);

  switch (provider) {
    case "brave":
      return createBraveSearchMCPClient();
    case "tavily":
      return createTavilyMCPClient();
    case "serpapi":
      return createSerpAPIMCPClient();
    default:
      console.warn(
        `[Web Search MCP] Unknown provider: ${provider}, falling back to Brave`
      );
      return createBraveSearchMCPClient();
  }
}

/**
 * Create MCP client for Brave Search.
 * Uses the official @anthropic/mcp-brave-search package via npx.
 */
async function createBraveSearchMCPClient() {
  const apiKey = process.env.BRAVE_SEARCH_API_KEY;

  if (!apiKey) {
    console.warn("[Web Search MCP] BRAVE_SEARCH_API_KEY not configured");
    return null;
  }

  console.log("[Web Search MCP] Creating Brave Search MCP client");

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [
        string,
        string
      ][]
    ),
    BRAVE_API_KEY: apiKey,
  };

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@anthropic/mcp-brave-search"],
    env,
    stderr: "pipe",
  });

  try {
    const mcpClient = await createMCPClient({ transport });

    const stderr = transport.stderr;
    if (stderr) {
      stderr.on("data", (data: Buffer) => {
        console.log("[Web Search MCP] stderr:", data.toString());
      });
    }

    const tools = await mcpClient.tools();
    console.log("[Web Search MCP] Brave tools available:", Object.keys(tools));

    return {
      tools: async () => tools,
      provider: "brave" as const,
      async close() {
        console.log("[Web Search MCP] Closing Brave MCP client...");
        try {
          await mcpClient.close();
          console.log("[Web Search MCP] Brave MCP client closed successfully");
        } catch (error) {
          console.error("[Web Search MCP] Error closing Brave MCP client:", error);
          throw error;
        }
      },
    };
  } catch (error) {
    console.error("[Web Search MCP] Failed to create Brave MCP client:", error);
    return null;
  }
}

/**
 * Create MCP client for Tavily.
 * Uses the @anthropic/mcp-tavily package via npx.
 */
async function createTavilyMCPClient() {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    console.warn("[Web Search MCP] TAVILY_API_KEY not configured");
    return null;
  }

  console.log("[Web Search MCP] Creating Tavily MCP client");

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [
        string,
        string
      ][]
    ),
    TAVILY_API_KEY: apiKey,
  };

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@anthropic/mcp-tavily"],
    env,
    stderr: "pipe",
  });

  try {
    const mcpClient = await createMCPClient({ transport });

    const stderr = transport.stderr;
    if (stderr) {
      stderr.on("data", (data: Buffer) => {
        console.log("[Web Search MCP] stderr:", data.toString());
      });
    }

    const tools = await mcpClient.tools();
    console.log("[Web Search MCP] Tavily tools available:", Object.keys(tools));

    return {
      tools: async () => tools,
      provider: "tavily" as const,
      async close() {
        console.log("[Web Search MCP] Closing Tavily MCP client...");
        try {
          await mcpClient.close();
          console.log("[Web Search MCP] Tavily MCP client closed successfully");
        } catch (error) {
          console.error("[Web Search MCP] Error closing Tavily MCP client:", error);
          throw error;
        }
      },
    };
  } catch (error) {
    console.error("[Web Search MCP] Failed to create Tavily MCP client:", error);
    return null;
  }
}

/**
 * Create MCP client for SerpAPI.
 * Uses a stdio-based MCP server.
 */
async function createSerpAPIMCPClient() {
  const apiKey = process.env.SERPAPI_API_KEY;

  if (!apiKey) {
    console.warn("[Web Search MCP] SERPAPI_API_KEY not configured");
    return null;
  }

  console.log("[Web Search MCP] Creating SerpAPI MCP client");

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [
        string,
        string
      ][]
    ),
    SERPAPI_API_KEY: apiKey,
  };

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["-y", "@anthropic/mcp-serpapi"],
    env,
    stderr: "pipe",
  });

  try {
    const mcpClient = await createMCPClient({ transport });

    const stderr = transport.stderr;
    if (stderr) {
      stderr.on("data", (data: Buffer) => {
        console.log("[Web Search MCP] stderr:", data.toString());
      });
    }

    const tools = await mcpClient.tools();
    console.log("[Web Search MCP] SerpAPI tools available:", Object.keys(tools));

    return {
      tools: async () => tools,
      provider: "serpapi" as const,
      async close() {
        console.log("[Web Search MCP] Closing SerpAPI MCP client...");
        try {
          await mcpClient.close();
          console.log("[Web Search MCP] SerpAPI MCP client closed successfully");
        } catch (error) {
          console.error("[Web Search MCP] Error closing SerpAPI MCP client:", error);
          throw error;
        }
      },
    };
  } catch (error) {
    console.error("[Web Search MCP] Failed to create SerpAPI MCP client:", error);
    return null;
  }
}

export type WebSearchMCPClient = Awaited<
  ReturnType<typeof createWebSearchMCPClient>
>;
