import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Mark packages that should only run on the server
  // These packages contain native modules or need to be external
  serverExternalPackages: [
    "@ai-sdk/mcp",
    "ssh2",
    "cpu-features",
    "agent-backend",
  ],
  // Empty turbopack config to silence warning
  turbopack: {},
};

export default nextConfig;
