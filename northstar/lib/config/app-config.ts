// Next.js automatically loads .env.local in development and .env.production in production
// No manual dotenv loading needed

export interface AppConfig {
  // Application
  isDevelopment: boolean;
  isProduction: boolean;
  BASE_URL: string;

  // Database
  POSTGRES_URL: string;

  // Upstash Redis (Vercel KV)
  KV_REST_API_URL: string;
  KV_REST_API_TOKEN: string;

  // OpenRouter
  OPENROUTER_API_KEY: string;

  // Agent Backend (filesystem backend for agents)
  // Local backend used in development, remote backend in production
  CONSTELLATION_HOST?: string;             // Remote host (e.g., "server.example.com") - required in production
  CONSTELLATION_SSH_PORT?: number;         // SSH port (defaults to 2222)
  CONSTELLATION_SSH_PASSWORD?: string;     // SSH password - required in production
  CONSTELLATION_MCP_TOKEN?: string;        // MCP auth token - required in production
  CONSTELLATION_MCP_PORT?: number;         // MCP port (defaults to 3001)
  CONSTELLATION_WORKSPACE: string;         // e.g., "default" or "tasks"
  CONSTELLATION_WORKSPACE_ROOT: string;    // Root directory for agent backend workspace

  // OAuth - Google
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;

  // Notion - Internal integration (preferred for personal use)
  NOTION_INTERNAL_TOKEN: string;

  // Slack (OAuth handled by ChatKit)
  SLACK_APP_ID?: string;
  SLACK_TEAM_ID?: string; // For checking connection status via ChatKit

  // X Manager / Browser-use
  BROWSER_USE_API_KEY?: string;
  BROWSER_USE_PROFILE_ID?: string;
  BROWSER_USE_HEADLESS: boolean; // Whether to run browser in headless mode
  // X_USERNAME is now configured via UI settings, not env vars

  // Porter/ChatKit
  CHATKIT_BASE_URL: string;
  CHATKIT_SECRET: string;
  ADMIN_TOKEN_KEY: string;
  JWT_SECRET_KEY: string;

  // Langfuse
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_ENABLED: boolean;
}

function requireEnvVar(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function getOptionalEnvVar(key: string, defaultValue = ""): string {
  return process.env[key] || defaultValue;
}

export function createAppConfig(): AppConfig {
  const NODE_ENV = getOptionalEnvVar("NODE_ENV", "development");
  const PORT = parseInt(getOptionalEnvVar("PORT", "3000"), 10);

  if (isNaN(PORT)) {
    throw new Error("PORT must be a valid number");
  }

  const isDevelopment = NODE_ENV === "development";
  const isProduction = NODE_ENV === "production";

  const config: AppConfig = {
    // Application
    isDevelopment,
    isProduction,
    BASE_URL: getOptionalEnvVar("BASE_URL", "http://localhost:3000"),

    // Database (POSTGRES_URL is auto-injected by Vercel Postgres)
    POSTGRES_URL: process.env.POSTGRES_URL || requireEnvVar("POSTGRES_URL"),

    // Upstash Redis (Vercel KV)
    KV_REST_API_URL: requireEnvVar("KV_REST_API_URL"),
    KV_REST_API_TOKEN: requireEnvVar("KV_REST_API_TOKEN"),

    // OpenRouter
    OPENROUTER_API_KEY: requireEnvVar("OPENROUTER_API_KEY"),

    // Agent Backend - local backend in dev, remote in production
    // Remote settings only required in production
    CONSTELLATION_HOST: isProduction ? requireEnvVar("CONSTELLATION_HOST") : getOptionalEnvVar("CONSTELLATION_HOST"),
    CONSTELLATION_SSH_PORT: process.env.CONSTELLATION_SSH_PORT
      ? parseInt(process.env.CONSTELLATION_SSH_PORT, 10)
      : undefined,
    CONSTELLATION_SSH_PASSWORD: getOptionalEnvVar("CONSTELLATION_SSH_PASSWORD"),
    CONSTELLATION_MCP_TOKEN: isProduction ? requireEnvVar("CONSTELLATION_MCP_TOKEN") : getOptionalEnvVar("CONSTELLATION_MCP_TOKEN"),
    CONSTELLATION_MCP_PORT: process.env.CONSTELLATION_MCP_PORT
      ? parseInt(process.env.CONSTELLATION_MCP_PORT, 10)
      : undefined,
    CONSTELLATION_WORKSPACE: getOptionalEnvVar("CONSTELLATION_WORKSPACE", "default"),
    CONSTELLATION_WORKSPACE_ROOT: requireEnvVar("CONSTELLATION_WORKSPACE_ROOT"),

    // OAuth - Google
    GOOGLE_CLIENT_ID: requireEnvVar("GOOGLE_CLIENT_ID"),
    GOOGLE_CLIENT_SECRET: requireEnvVar("GOOGLE_CLIENT_SECRET"),
    GOOGLE_REDIRECT_URI: getOptionalEnvVar(
      "GOOGLE_REDIRECT_URI",
      `http://localhost:${PORT}/api/auth/google/callback`
    ),

    // Notion - Internal integration token (preferred)
    NOTION_INTERNAL_TOKEN: requireEnvVar("NOTION_INTERNAL_TOKEN"),

    // Slack (OAuth handled by ChatKit)
    SLACK_APP_ID: getOptionalEnvVar("SLACK_APP_ID"),
    SLACK_TEAM_ID: getOptionalEnvVar("SLACK_TEAM_ID"),

    // X Manager / Browser-use
    BROWSER_USE_API_KEY: getOptionalEnvVar("BROWSER_USE_API_KEY"),
    BROWSER_USE_PROFILE_ID: getOptionalEnvVar("BROWSER_USE_PROFILE_ID"),
    BROWSER_USE_HEADLESS: isProduction, // Show browser in dev, headless in prod
    // X_USERNAME is now configured via UI settings

    // Porter/ChatKit
    CHATKIT_BASE_URL: requireEnvVar("CHATKIT_BASE_URL"),
    CHATKIT_SECRET: requireEnvVar("CHATKIT_SECRET"),
    ADMIN_TOKEN_KEY: requireEnvVar("ADMIN_TOKEN_KEY"),
    JWT_SECRET_KEY: requireEnvVar("JWT_SECRET_KEY"),

    // Langfuse
    LANGFUSE_SECRET_KEY: getOptionalEnvVar("LANGFUSE_SECRET_KEY"),
    LANGFUSE_PUBLIC_KEY: getOptionalEnvVar("LANGFUSE_PUBLIC_KEY"),
    LANGFUSE_BASE_URL: getOptionalEnvVar("LANGFUSE_BASE_URL", "https://us.cloud.langfuse.com"),
    LANGFUSE_ENABLED: !!getOptionalEnvVar("LANGFUSE_SECRET_KEY") && !!getOptionalEnvVar("LANGFUSE_PUBLIC_KEY"),
  };

  return config;
}

// Lazy initialization to avoid errors during build
let _appConfig: AppConfig | null = null;

export function getAppConfig(): AppConfig {
  if (!_appConfig) {
    _appConfig = createAppConfig();
  }
  return _appConfig;
}

// For cases where we know config is already initialized
export const appConfig = new Proxy({} as AppConfig, {
  get(_, prop: keyof AppConfig) {
    return getAppConfig()[prop];
  },
});
