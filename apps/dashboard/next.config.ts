import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Workspace packages are TypeScript source — let Next transpile them.
  transpilePackages: ["@linkchecker/db", "@linkchecker/core", "@linkchecker/analyzers"],
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
