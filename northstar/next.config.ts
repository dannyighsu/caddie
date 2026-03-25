import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["uuid", "pg", "ioredis"],
};

export default nextConfig;
