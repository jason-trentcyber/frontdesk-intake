import { execSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync } from "node:fs";

/**
 * Shared by every spec in this directory (ADR-0030): a real `next build`
 * plus the real standalone server.js, matching web/Dockerfile exactly -
 * not `next dev`/`next start`, which doesn't exercise the standalone
 * output at all (and `next start` prints its own warning saying so).
 * `pnpm run build` is only invoked once per process even if multiple
 * specs call this (`next build` is deterministic and idempotent against
 * the same source; playwright.config.ts serializes specs to one worker
 * anyway).
 */
export function buildOnce(): void {
  execSync("pnpm run build", { cwd: process.cwd(), stdio: "inherit" });
  const staticSrc = ".next/static";
  const staticDest = ".next/standalone/web/.next/static";
  if (!existsSync(staticDest)) {
    cpSync(staticSrc, staticDest, { recursive: true });
  }
}

export interface StartServerOptions {
  port: number;
  env: Record<string, string | undefined>;
}

export function startServer({ port, env }: StartServerOptions): ChildProcess {
  return spawn("node", [".next/standalone/web/server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      // Loopback only - this VPS has a public IP; binding 0.0.0.0 for an
      // ad-hoc local server is exactly the mistake that has caused a
      // real incident here before (docs/adr/0028-compose-loopback-port-bindings.md).
      HOSTNAME: "127.0.0.1",
    },
    stdio: "inherit",
  });
}

export async function waitForHealthy(url: string, attempts = 60): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`${url} did not become healthy`);
}
