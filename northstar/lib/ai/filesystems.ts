import { LocalFilesystemBackend, RemoteFilesystemBackend } from "agent-backend";
import { VercelAIAdapter } from "agent-backend/adapters";
import { getAppConfig } from "../config/app-config";

type Backend = LocalFilesystemBackend | RemoteFilesystemBackend;

/**
 * Create a backend instance for the given user.
 * Uses local backend in development, remote backend in production.
 */
export function createBackend(_userId: string): Backend {
  const config = getAppConfig();

  // Use local backend in development for simpler setup
  if (config.isDevelopment) {
    console.log('[FileSystem] Using LOCAL backend for development');
    return new LocalFilesystemBackend({
      rootDir: config.CONSTELLATION_WORKSPACE_ROOT,
      preventDangerous: false,
      shell: "auto",
      isolation: "none",
    });
  }

  // Use remote backend in production
  const backend = new RemoteFilesystemBackend({
    rootDir: config.CONSTELLATION_WORKSPACE_ROOT,
    host: config.CONSTELLATION_HOST!,
    sshAuth: {
      type: "password",
      credentials: {
        username: "constellation",
        password: config.CONSTELLATION_SSH_PASSWORD ?? "",
      },
    },
    authToken: config.CONSTELLATION_MCP_TOKEN!,
    ...(config.CONSTELLATION_SSH_PORT && { sshPort: config.CONSTELLATION_SSH_PORT }),
    ...(config.CONSTELLATION_MCP_PORT && { port: config.CONSTELLATION_MCP_PORT }),
  });

  console.log('[FileSystem] Using REMOTE backend for production');
  return backend;
}

// Keep old name as alias for consumers that haven't updated yet
export const createFileSystem = createBackend;

export interface CreateMCPClientOptions {
  userId: string;
  workspace?: string;
}

/**
 * Create an MCP client for the Vercel AI SDK.
 * Uses VercelAIAdapter to get MCP client from the backend.
 */
export async function createBackendMCPClient(options: CreateMCPClientOptions) {
  const config = getAppConfig();
  const backend = createBackend(options.userId);
  const workspace = options.workspace ?? config.CONSTELLATION_WORKSPACE;

  // Scope the backend to the workspace, then wrap with VercelAIAdapter
  const scopedBackend = backend.scope(workspace);
  const adapter = new VercelAIAdapter(scopedBackend);
  const mcpClient = await adapter.getMCPClient();

  console.log('[MCP Client] Creating MCP client for workspace:', workspace);

  const tools = await mcpClient.tools();
  console.log('[MCP Client] MCP client created, tools:', Object.keys(tools));

  return {
    tools: async () => tools,
    async close() {
      await backend.destroy();
    },
  };
}

// Keep old name as alias for consumers that haven't updated yet
export const createConstellationMCPClient = createBackendMCPClient;

export type MCPClient = Awaited<ReturnType<typeof createBackendMCPClient>>;
