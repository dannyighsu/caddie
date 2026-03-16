import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { getAppConfig } from "../config/app-config";

export interface CreateNotionMCPClientOptions {
  userId: string;
}

/**
 * Create an MCP client for Notion tools.
 * Spawns the Notion MCP server locally via stdio.
 *
 * Note: Notion provides a hosted MCP server at https://mcp.notion.com/sse but it
 * requires OAuth authentication. For server-side agents using internal integration
 * tokens (NOTION_INTERNAL_TOKEN), we spawn the MCP server locally instead.
 */
export async function createNotionMCPClient(_options: CreateNotionMCPClientOptions) {
  const config = getAppConfig();

  if (!config.NOTION_INTERNAL_TOKEN) {
    console.warn('[Notion MCP] NOTION_INTERNAL_TOKEN not configured');
    return null;
  }

  console.log('[Notion MCP] Spawning local Notion MCP server');

  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: {
      ...process.env,
      NOTION_TOKEN: config.NOTION_INTERNAL_TOKEN,
    } as Record<string, string>,
    stderr: 'pipe',
  });

  const mcpClient = await createMCPClient({ transport });
  const tools = await mcpClient.tools();
  console.log('[Notion MCP] Tools available:', Object.keys(tools));

  return {
    tools: async () => tools,
    async close() {
      await mcpClient.close();
    },
  };
}

export type NotionMCPClient = Awaited<ReturnType<typeof createNotionMCPClient>>;

/**
 * Get Notion MCP tools for use in agent
 */
export async function getNotionMCPTools(userId: string): Promise<Record<string, any>> {
  try {
    const client = await createNotionMCPClient({ userId });
    if (!client) return {};

    const tools = await client.tools();
    return tools;
  } catch (error) {
    console.error('[Notion MCP] Failed to get tools:', error);
    return {};
  }
}
