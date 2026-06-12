import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Lean, self-contained server output for Docker. In a monorepo Next must
  // trace files from the repo root so workspace packages are bundled.
  output: "standalone",
  outputFileTracingRoot: path.join(import.meta.dirname, "../../"),

  // Workspace packages are TypeScript source — let Next transpile them.
  transpilePackages: [
    "@linkchecker/db",
    "@linkchecker/core",
    "@linkchecker/analyzers",
    "@linkchecker/queue",
    "@linkchecker/ai",
  ],
  webpack: (config) => {
    // The workspace packages use NodeNext-style ".js" import specifiers that
    // actually resolve to ".ts" files. Teach webpack to follow them.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};

export default nextConfig;
