import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["uuid", "pg", "ioredis", "@slack/socket-mode", "@slack/web-api", "@whiskeysockets/baileys"],
};

export default nextConfig;
