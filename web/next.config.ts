import type { NextConfig } from "next";

// Static export: the site is plain files served by Caddy, and every chain read happens in the browser.
const nextConfig: NextConfig = {
  output: process.env.NODE_ENV === "development" ? undefined : "export",
  ...(process.env.NODE_ENV === "development" && process.env.NEXT_PUBLIC_NETWORK === "sandbox" ? {
    async rewrites() {
      return [{ source: "/local-rpc", destination: process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:3030" }];
    },
  } : {}),
  // The dev server refuses scripts requested from another origin; this lets the page be opened as 127.0.0.1 too.
  allowedDevOrigins: ["127.0.0.1", "192.168.1.33"],
  // The dev server reused an old compiled stylesheet after restarts and served CSS without my newest variables.
  experimental: { turbopackFileSystemCacheForDev: false, turbopackFileSystemCacheForBuild: false },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
