import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Multi-stage Dockerfile copies only .next/standalone + .next/static
  // (deploy/README.md); needed for the non-root, minimal runtime image.
  output: "standalone",
};

export default nextConfig;
