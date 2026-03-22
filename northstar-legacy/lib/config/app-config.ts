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

  // Workspace (local filesystem for agent data)
  WORKSPACE_ROOT?: string; // Defaults to <project-root>/workspace/

  // OAuth - Google
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;

  // Notion - Internal integration (preferred for personal use)
  NOTION_INTERNAL_TOKEN: string;

  // Slack (OAuth handled by ChatKit)
  SLACK_APP_ID?: string;
  SLACK_TEAM_ID?: string; // For checking connection status via ChatKit

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

    // Workspace
    WORKSPACE_ROOT: getOptionalEnvVar("WORKSPACE_ROOT") || undefined,

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
