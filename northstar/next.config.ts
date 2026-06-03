import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["uuid", "pg", "ioredis", "@slack/socket-mode", "@slack/web-api", "agentmail"],
};

export default nextConfig;
