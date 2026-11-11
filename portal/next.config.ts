import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["uuid", "pg", "ioredis", "@slack/socket-mode", "@slack/web-api", "googleapis", "nodemailer"],
};

export default nextConfig;
