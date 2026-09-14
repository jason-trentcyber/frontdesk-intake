import { defineConfig } from "@playwright/test";

// ADR-0030. Each spec builds its own real `next build` + spawns the real
// standalone server.js in its own test.beforeAll (not Playwright's
// `webServer` option, which assumes one long-lived server shared by
// every test - these specs need distinct ports, env, and seeded
// Postgres state per run). One worker, not parallel: this VPS is a
// single small node, and two specs each running a Next build plus a
// Chromium instance at once is the same resource-contention shape
// already learned the hard way running `pnpm -r test` locally - avoided
// here by serializing rather than relying on CI's runner size to paper
// over it.
export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["json", { outputFile: "playwright-report.json" }]],
  use: {
    headless: true,
  },
});
