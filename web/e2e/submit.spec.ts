import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChildProcess } from "node:child_process";
import { createDb, forOrg, orgs, requests, type Db } from "@frontdesk/db";
import { eq, inArray } from "drizzle-orm";
import { chromium, expect, test, type Browser } from "@playwright/test";
import { buildOnce, startServer, waitForHealthy } from "./webServer";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

const WEB_PORT = 3411;

/**
 * Migrated from web/src/app/r/[slug]/submit.e2e.test.ts (vitest +
 * puppeteer-core) to Playwright (ADR-0030) - same regression, same
 * rigor, only the runner and browser-driver library changed. Regression
 * for #112's production incident: web/src/lib/actions.ts (a "use
 * server" module) exported INITIAL_SUBMIT_STATE, a plain object,
 * alongside submitPublicRequest. Next requires every runtime export of
 * a "use server" file to be an async function - each becomes a callable
 * action endpoint - so the module threw "A 'use server' file can only
 * export async functions, found object" the moment anything tried to
 * invoke an action from it. Every existing test imported
 * submitPublicRequest as a plain function (vitest, no Next runtime
 * involved) and passed; Lighthouse only ever GETs pages; the Docker
 * build compiles fine. Nothing in CI evaluated this module inside a
 * real Next server - which is exactly what a Server Action invocation
 * requires, and exactly what this test does instead.
 *
 * api/ is a minimal, trusted stand-in (see stubApi below) - api/'s own
 * correctness is already covered by its own test suite and is
 * explicitly out of scope for this regression, which happened entirely
 * inside web/ before any HTTP call to api/ was ever made.
 */
test.describe(hasEnv ? "public form submission over real HTTP (regression for #112)" : "public form submission over real HTTP (regression for #112) [skipped: DATABASE_URL/DATABASE_APP_URL not set]", () => {
  test.skip(!hasEnv);

  let ownerDb: Db;
  let demoOrgId: string;
  let demoOrgSlug: string;
  let stubApi: Server;
  let stubApiPort: number;
  let webProcess: ChildProcess;
  let browser: Browser;
  const createdRequestIds: string[] = [];

  test.beforeAll(async () => {
    ownerDb = createDb(ownerUrl!);
    const [org] = await ownerDb.select({ id: orgs.id, slug: orgs.slug }).from(orgs).limit(1);
    if (!org) throw new Error("expected at least one seeded org - run `pnpm seed` first");
    demoOrgId = org.id;
    demoOrgSlug = org.slug;

    stubApi = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        void (async () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { subject: string; body: string };
          const trackingToken = randomUUID();
          const requestId = await forOrg(ownerDb, demoOrgId, async (tx, orgId) => {
            const [row] = await tx
              .insert(requests)
              .values({ orgId, source: "form", subject: body.subject, body: body.body, trackingToken })
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

    buildOnce();
    webProcess = startServer({
      port: WEB_PORT,
      env: {
        DATABASE_URL: appUrl!,
        API_ORIGIN: `http://127.0.0.1:${stubApiPort}`,
        // Cloudflare's official, permanent always-pass test site key -
        // works on any domain including 127.0.0.1, no real account or
        // widget domain allowlist needed:
        // developers.cloudflare.com/turnstile/troubleshooting/testing/
        TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
      },
    });
    await waitForHealthy(`http://127.0.0.1:${WEB_PORT}/healthz`);

    // Playwright's own bundled Chromium (ADR-0030) - no
    // PUPPETEER_EXECUTABLE_PATH-shaped override needed, unlike the
    // puppeteer-core version this replaces.
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  });

  test.afterAll(async () => {
    await browser?.close();
    webProcess?.kill();
    stubApi?.close();
    if (createdRequestIds.length > 0) {
      await ownerDb.delete(requests).where(inArray(requests.id, createdRequestIds));
    }
  });

  test("submitting the real rendered form succeeds - no 500, and a real row lands in the DB", async () => {
    const page = await browser.newPage();
    const subject = `e2e submission ${randomUUID()}`;
    const bodyText = "Does the real Next server dispatch this action without crashing?";

    const statuses: number[] = [];
    page.on("response", (res) => statuses.push(res.status()));

    // "load", not "networkidle": verified locally that Turnstile's real
    // widget keeps background network activity going past Playwright's
    // idle window, so "networkidle" hangs to this test's full timeout
    // here even though the page has long since finished loading -
    // Playwright's own docs call "networkidle" discouraged for exactly
    // this reason. The explicit waitForFunction below is what actually
    // gates on Turnstile being ready, not this navigation wait.
    await page.goto(`http://127.0.0.1:${WEB_PORT}/r/${demoOrgSlug}`, { waitUntil: "load" });
    await page.fill('input[name="subject"]', subject);
    await page.fill('textarea[name="body"]', bodyText);

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
    await Promise.all([page.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${WEB_PORT}/t/[^/]+$`)), page.click('button[type="submit"]')]);

    // The exact regression: before the fix, the action-dispatch request
    // itself came back 500 with "A 'use server' file can only export
    // async functions" in the server log, and the browser never
    // navigated anywhere.
    expect(statuses).not.toContain(500);
    expect(page.url()).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${WEB_PORT}/t/[^/]+$`));

    const rows = await ownerDb.select().from(requests).where(eq(requests.subject, subject));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe(bodyText);
    expect(rows[0]?.source).toBe("form");

    await page.close();
  });
});
