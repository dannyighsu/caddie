import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["uuid", "pg"],
};

export default nextConfig;
