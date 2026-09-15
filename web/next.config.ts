import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Multi-stage Dockerfile copies only .next/standalone + .next/static
  // (deploy/README.md); needed for the non-root, minimal runtime image.
  output: "standalone",

  // The floating Next.js dev-tools button ("N", bottom-left). It exists
  // only under `next dev` and never appears in a production build, so
  // this changes nothing about what ships - it keeps a framework badge
  // off the footer during a local demo. Errors still surface normally.
  //
  // The `false` shape is typed by the pinned version itself
  // (next/dist/server/config-shared.d.ts: `devIndicators?: false | {...}`),
  // so `pnpm typecheck` fails if a Next upgrade ever narrows it - no
  // changelog reference needed to keep this honest.
  devIndicators: false,
};

export default nextConfig;
