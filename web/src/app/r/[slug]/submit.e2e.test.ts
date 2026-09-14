import { randomUUID } from "node:crypto";
import { execSync, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDb, forOrg, orgs, requests, type Db } from "@frontdesk/db";
import { getChromePath } from "chrome-launcher";
import { eq, inArray } from "drizzle-orm";
import puppeteer, { type Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

const WEB_PORT = 3411;

async function waitForHealthy(url: string, attempts = 60): Promise<void> {
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

/**
 * Regression test for #112's production incident: web/src/lib/actions.ts
 * (a "use server" module) exported INITIAL_SUBMIT_STATE, a plain object,
 * alongside submitPublicRequest. Next requires every runtime export of a
 * "use server" file to be an async function - each becomes a callable
 * action endpoint - so the module threw "A 'use server' file can only
 * export async functions, found object" the moment anything tried to
 * invoke an action from it. Every existing test imported
 * submitPublicRequest as a plain function (vitest, no Next runtime
 * involved) and passed; Lighthouse only ever GETs pages; the Docker
 * build compiles fine. Nothing in CI evaluated this module inside a
 * real Next server - which is exactly what a Server Action invocation
 * requires, and exactly what this test does instead.
 *
 * This drives the actual rendered form through a real headless browser
 * against the real production build (`next build` + the real standalone
 * server.js, matching web/Dockerfile exactly - not `next dev`/`next
 * start`, which doesn't exercise the standalone output at all and
 * prints its own warning saying so). api/ is a minimal, trusted stand-in
 * (see stubApi below) - api/'s own correctness is already covered by
 * its own test suite and is explicitly out of scope for this regression,
 * which happened entirely inside web/ before any HTTP call to api/ was
 * ever made.
 */
describe.skipIf(!hasEnv)(
  hasEnv
    ? "public form submission over real HTTP (regression for #112)"
    : "public form submission over real HTTP (regression for #112) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let demoOrgId: string;
    let demoOrgSlug: string;
    let stubApi: Server;
    let stubApiPort: number;
    let webProcess: ChildProcess;
    let browser: Browser;
    const createdRequestIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      const [org] = await ownerDb.select({ id: orgs.id, slug: orgs.slug }).from(orgs).limit(1);
      if (!org) throw new Error("expected at least one seeded org - run `pnpm seed` first");
      demoOrgId = org.id;
      demoOrgSlug = org.slug;

      // Minimal stand-in for api/'s real intake endpoint - see the
      // module doc comment above for why api/ itself isn't run here.
      // Inserts a real row via @frontdesk/db (already a real dependency
      // of web/) so this test's DB assertion is genuine, not mocked.
      stubApi = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          void (async () => {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
              subject: string;
              body: string;
            };
            const trackingToken = randomUUID();
            const requestId = await forOrg(ownerDb, demoOrgId, async (tx, orgId) => {
              const [row] = await tx
                .insert(requests)
                .values({
                  orgId,
                  source: "form",
                  subject: body.subject,
                  body: body.body,
                  trackingToken,
                })
                .returning({ id: requests.id });
              if (!row) throw new Error("stub insert returned no row");
              return row.id;
            });
            createdRequestIds.push(requestId);
            res.writeHead(201, { "content-type": "application/json" });
            res.end(JSON.stringify({ trackingToken, trackingUrl: `http://127.0.0.1:${WEB_PORT}/t/${trackingToken}` }));
          })();
        });
      });
      await new Promise<void>((resolve) => stubApi.listen(0, "127.0.0.1", resolve));
      stubApiPort = (stubApi.address() as AddressInfo).port;

      // Real `next build`, then the real standalone server (matching
      // web/Dockerfile exactly) - db/dist is already built by web's own
      // pretest hook.
      execSync("pnpm run build", { cwd: process.cwd(), stdio: "inherit" });
      const staticSrc = ".next/static";
      const staticDest = ".next/standalone/web/.next/static";
      if (!existsSync(staticDest)) {
        cpSync(staticSrc, staticDest, { recursive: true });
      }

      webProcess = spawn("node", [".next/standalone/web/server.js"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          PORT: String(WEB_PORT),
          HOSTNAME: "127.0.0.1",
          DATABASE_URL: appUrl!,
          API_ORIGIN: `http://127.0.0.1:${stubApiPort}`,
          // Cloudflare's official, permanent always-pass test site key -
          // works on any domain including 127.0.0.1, no real account or
          // widget domain allowlist needed:
          // developers.cloudflare.com/turnstile/troubleshooting/testing/
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        },
        stdio: "inherit",
      });
      await waitForHealthy(`http://127.0.0.1:${WEB_PORT}/healthz`);

      // PUPPETEER_EXECUTABLE_PATH (puppeteer's own standard env var) lets
      // this be pointed at a specific browser when the platform default
      // chrome-launcher would find isn't launchable as a plain child
      // process (this repo's own dev VPS only has a snap-packaged
      // Chromium, which requires snap's own confinement to start) -
      // ubuntu-latest's preinstalled Chrome needs no override.
      const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH ?? getChromePath();
      browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
    }, 180_000);

    afterAll(async () => {
      await browser?.close();
      webProcess?.kill();
      stubApi?.close();
      if (createdRequestIds.length > 0) {
        await ownerDb.delete(requests).where(inArray(requests.id, createdRequestIds));
      }
    });

    it("submitting the real rendered form succeeds - no 500, and a real row lands in the DB", async () => {
      const page = await browser.newPage();
      const subject = `e2e submission ${randomUUID()}`;
      const bodyText = "Does the real Next server dispatch this action without crashing?";

      const statuses: number[] = [];
      page.on("response", (res) => statuses.push(res.status()));

      await page.goto(`http://127.0.0.1:${WEB_PORT}/r/${demoOrgSlug}`, { waitUntil: "networkidle0" });
      await page.type('input[name="subject"]', subject);
      await page.type('textarea[name="body"]', bodyText);

      // Turnstile's real widget script, using the always-pass test site
      // key, auto-completes and injects this hidden field itself - same
      // as a real visitor's browser, no manual interaction simulated.
      await page.waitForFunction(
        () => {
          const el = document.querySelector('input[name="cf-turnstile-response"]');
          return el instanceof HTMLInputElement && el.value.length > 0;
        },
        { timeout: 30_000 },
      );

      statuses.length = 0;
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle0" }),
        page.click('button[type="submit"]'),
      ]);

      // The exact regression: before the fix, the action-dispatch
      // request itself came back 500 with "A 'use server' file can only
      // export async functions" in the server log, and the browser never
      // navigated anywhere.
      expect(statuses).not.toContain(500);
      expect(page.url()).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${WEB_PORT}/t/[^/]+$`));

      const rows = await ownerDb.select().from(requests).where(eq(requests.subject, subject));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.body).toBe(bodyText);
      expect(rows[0]?.source).toBe("form");

      await page.close();
    }, 60_000);
  },
);
