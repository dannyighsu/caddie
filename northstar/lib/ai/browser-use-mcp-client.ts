import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAppConfig } from "../config/app-config";

export interface BrowserUseMCPClientOptions {
  profileId?: string;
}

/**
 * Create an MCP client for browser-use tools.
 *
 * In development: Spawns local stdio MCP server using uvx, uses local browser
 * In production: Connects to browser-use's hosted SSE server
 *
 * Local mode requires OPENAI_API_KEY or ANTHROPIC_API_KEY.
 * Cloud mode requires BROWSER_USE_API_KEY.
 */
export async function createBrowserUseMCPClient(
  options: BrowserUseMCPClientOptions = {}
) {
  const config = getAppConfig();

  if (config.isDevelopment) {
    return createLocalBrowserUseMCPClient(options);
  } else {
    return createCloudBrowserUseMCPClient(options);
  }
}

/**
 * Create a local stdio-based browser-use MCP client.
 * Spawns the browser-use MCP server locally using uvx.
 *
 * The MCP server uses its own browser profile at ~/.config/browseruse/profiles/default.
 * To log in to X, use the "Login to X" button in the UI which will open the browser
 * and let you log in manually. The session will be persisted for future runs.
 */
async function createLocalBrowserUseMCPClient(
  options: BrowserUseMCPClientOptions = {}
) {
  const config = getAppConfig();

  console.log("[Browser-use MCP] Creating LOCAL stdio MCP client");

  // Build environment with LLM API keys and browser settings
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][]
    ),
    // Pass through LLM API keys (browser-use needs one of these)
    OPENAI_API_KEY: process.env.OPENAI_API_KEY || "",
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    // Browser configuration from app config
    BROWSER_USE_HEADLESS: config.BROWSER_USE_HEADLESS ? "true" : "false",
    // Recording configuration (development mode only)
    // Fixed path so each run overwrites the previous recording
    MCP_AGENT_TOOL_HISTORY_PATH: `${process.cwd()}/recordings/latest`,
  };

  // Build CLI arguments - let MCP use its default profile at ~/.config/browseruse/profiles/default
  // Note: The --user-data-dir CLI flag has a bug in browser-use v0.11.2 that causes
  // "got multiple values for keyword argument" errors, so we don't pass it.
  const args = ["--from", "browser-use[cli]", "browser-use", "--mcp"];

  if (config.BROWSER_USE_HEADLESS) {
    args.push("--headless");
  }

  console.log("[Browser-use MCP] Using browser-use default profile at ~/.config/browseruse/profiles/default");

  // StdioClientTransport spawns the process itself
  // Note: Don't call transport.start() - createMCPClient does it automatically
  const transport = new StdioClientTransport({
    command: "uvx",
    args,
    env,
    stderr: "pipe", // Pipe stderr so we can log it
  });

  // createMCPClient will start the transport automatically
  const mcpClient = await createMCPClient({ transport });

  // Log stderr for debugging if available (after transport is started)
  const stderr = transport.stderr;
  if (stderr) {
    stderr.on("data", (data: Buffer) => {
      console.log("[Browser-use MCP] stderr:", data.toString());
    });
  }

  const tools = await mcpClient.tools();
  console.log("[Browser-use MCP] Local tools available:", Object.keys(tools));

  return {
    tools: async () => tools,
    profileId: options.profileId,
    isLocal: true,
    async close() {
      console.log("[Browser-use MCP] Closing local MCP client...");
      try {
        await mcpClient.close();
        console.log("[Browser-use MCP] MCP client closed successfully");
        // StdioClientTransport handles killing the process on close
      } catch (error) {
        console.error("[Browser-use MCP] Error closing MCP client:", error);
        throw error;
      }
    },
  };
}

/**
 * Create a cloud SSE-based browser-use MCP client.
 * Connects to browser-use's hosted MCP server.
 * Requires BROWSER_USE_API_KEY.
 */
async function createCloudBrowserUseMCPClient(
  options: BrowserUseMCPClientOptions = {}
) {
  const config = getAppConfig();

  if (!config.BROWSER_USE_API_KEY) {
    console.warn(
      "[Browser-use MCP] BROWSER_USE_API_KEY not configured for cloud mode"
    );
    return null;
  }

  console.log("[Browser-use MCP] Creating CLOUD SSE MCP client");

  const mcpClient = await createMCPClient({
    transport: {
      type: "sse",
      url: "https://api.browser-use.com/mcp",
      headers: {
        "X-Browser-Use-API-Key": config.BROWSER_USE_API_KEY,
      },
    },
  });

  const tools = await mcpClient.tools();
  console.log("[Browser-use MCP] Cloud tools available:", Object.keys(tools));

  return {
    tools: async () => tools,
    profileId: options.profileId,
    isLocal: false,
    async close() {
      console.log("[Browser-use MCP] Closing cloud MCP client...");
      try {
        await mcpClient.close();
        console.log("[Browser-use MCP] Cloud MCP client closed successfully");
      } catch (error) {
        console.error("[Browser-use MCP] Error closing cloud MCP client:", error);
        throw error;
      }
    },
  };
}

export type BrowserUseMCPClient = Awaited<
  ReturnType<typeof createBrowserUseMCPClient>
>;
