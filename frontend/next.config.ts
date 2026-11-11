import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep Turbopack scoped to this app; otherwise it walks up to the home
  // directory and picks up unrelated lockfiles.
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
