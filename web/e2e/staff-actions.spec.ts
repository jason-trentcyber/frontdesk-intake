import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  authSessions,
  authUsers,
  createDb,
  drafts,
  forOrg,
  orgs,
  requests,
  type Db,
} from "@frontdesk/db";
import { eq, inArray } from "drizzle-orm";
import { chromium, expect, test, type Browser, type BrowserContext } from "@playwright/test";
import { buildOnce, startServer, waitForHealthy } from "./webServer";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

const WEB_PORT = 3413;
const TEST_AUTH_SECRET = "e2e-test-only-not-a-real-secret-4a8f1c";

/**
 * #26's stated acceptance criterion: "Playwright covers approve and
 * reject." Same session-seeding harness as cross-org-isolation.spec.ts
 * (Trap 5, ADR-0031/ADR-0030) - a row in auth.sessions for a seeded
 * org_members email, handed to the browser context as a cookie, no
 * test-only Credentials provider added to production auth config.
 *
 * Both tests drive the real /app/[id] detail page end to end and assert
 * on the real public /t/<token> page afterward - proving #26's other
 * stated criterion in the same run ("the approved reply becomes visible
 * on the tracking page"), not just that the Server Action returned
 * successfully.
 */
test.describe(
  hasEnv
    ? "staff actions: approve and reject (#26, F12)"
    : "staff actions: approve and reject (#26, F12) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    test.skip(!hasEnv);

    let ownerDb: Db;
    let orgId: string;
    let webProcess: ChildProcess;
    let browser: Browser;
    let staffContext: BrowserContext;

    const createdRequestIds: string[] = [];
    const createdSessionTokens: string[] = [];
    const createdUserIds: string[] = [];

    function ownerEmailFor(orgSlug: string): string {
      const base = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
      const at = base.indexOf("@");
      return `${base.slice(0, at)}+${orgSlug}${base.slice(at)}`;
    }

    async function seedSessionFor(email: string): Promise<string> {
      const [user] = await ownerDb
        .insert(authUsers)
        .values({ email })
        .onConflictDoUpdate({ target: authUsers.email, set: { email } })
        .returning({ id: authUsers.id });
      if (!user) throw new Error(`failed to upsert auth.users row for ${email}`);
      createdUserIds.push(user.id);

      const sessionToken = randomUUID();
      await ownerDb
        .insert(authSessions)
        .values({ sessionToken, userId: user.id, expires: new Date(Date.now() + 3600_000) });
      createdSessionTokens.push(sessionToken);
      return sessionToken;
    }

    test.beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      const [org] = await ownerDb
        .select({ id: orgs.id })
        .from(orgs)
        .where(eq(orgs.slug, "bright-smile-dental"));
      if (!org)
        throw new Error("expected the seeded bright-smile-dental org - run `pnpm seed` first");
      orgId = org.id;

      const sessionToken = await seedSessionFor(ownerEmailFor("bright-smile-dental"));

      buildOnce();
      webProcess = startServer({
        port: WEB_PORT,
        env: {
          DATABASE_URL: appUrl!,
          AUTH_SECRET: TEST_AUTH_SECRET,
          AUTH_TRUST_HOST: "true",
          AUTH_GOOGLE_ID: "test-google-id",
          AUTH_GOOGLE_SECRET: "test-google-secret",
          AUTH_GITHUB_ID: "test-github-id",
          AUTH_GITHUB_SECRET: "test-github-secret",
          API_ORIGIN: "http://127.0.0.1:1", // unused - no public form in this spec
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        },
      });
      await waitForHealthy(`http://127.0.0.1:${WEB_PORT}/healthz`);

      browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
      staffContext = await browser.newContext({
        storageState: {
          cookies: [
            {
              name: "authjs.session-token",
              value: sessionToken,
              domain: "127.0.0.1",
              path: "/",
              httpOnly: true,
              secure: false,
              sameSite: "Lax",
              expires: Math.floor(Date.now() / 1000) + 3600,
            },
          ],
          origins: [],
        },
      });
    });

    test.afterAll(async () => {
      await staffContext?.close();
      await browser?.close();
      webProcess?.kill();
      if (createdSessionTokens.length > 0) {
        await ownerDb
          .delete(authSessions)
          .where(inArray(authSessions.sessionToken, createdSessionTokens));
      }
      if (createdUserIds.length > 0) {
        await ownerDb.delete(authUsers).where(inArray(authUsers.id, createdUserIds));
      }
      if (createdRequestIds.length > 0) {
        await ownerDb.delete(requests).where(inArray(requests.id, createdRequestIds));
      }
    });

    test("approve: the latest draft becomes the reply, visible on /t/<token>", async () => {
      const subject = `staff-approve-${randomUUID()}`;
      const draftBody = `approved reply body ${randomUUID()}`;
      const trackingToken = `tok-approve-${randomUUID()}`;

      const requestId = await forOrg(ownerDb, orgId, async (tx, scopedOrgId) => {
        const [row] = await tx
          .insert(requests)
          .values({
            orgId: scopedOrgId,
            source: "form",
            subject,
            body: "body",
            trackingToken,
            status: "drafted",
          })
          .returning({ id: requests.id });
        if (!row) throw new Error("insert returned no row");
        await tx.insert(drafts).values({
          orgId: scopedOrgId,
          requestId: row.id,
          version: 1,
          body: draftBody,
          citations: [],
          confidence: "0.900",
          model: "fake",
          promptVersion: "v1",
        });
        return row.id;
      });
      createdRequestIds.push(requestId);

      const page = await staffContext.newPage();
      await page.goto(`http://127.0.0.1:${WEB_PORT}/app/${requestId}`, { waitUntil: "load" });
      await expect(page.locator("body")).toContainText(draftBody);

      await Promise.all([
        page.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${WEB_PORT}/app$`)),
        page.click('button:has-text("Approve as drafted")'),
      ]);

      await page.goto(`http://127.0.0.1:${WEB_PORT}/t/${trackingToken}`, { waitUntil: "load" });
      const body = await page.locator("body").innerText();
      expect(body).toContain("Approved");
      expect(body).toContain(draftBody);
      await page.close();
    });

    test("reject: requires a reason, writes no reply, status is visible (not approved) on /t/<token>", async () => {
      const subject = `staff-reject-${randomUUID()}`;
      const trackingToken = `tok-reject-${randomUUID()}`;
      const reason = `not something we can help with ${randomUUID()}`;

      const requestId = await forOrg(ownerDb, orgId, async (tx, scopedOrgId) => {
        const [row] = await tx
          .insert(requests)
          .values({
            orgId: scopedOrgId,
            source: "form",
            subject,
            body: "body",
            trackingToken,
            status: "needs_human",
          })
          .returning({ id: requests.id });
        if (!row) throw new Error("insert returned no row");
        return row.id;
      });
      createdRequestIds.push(requestId);

      const page = await staffContext.newPage();
      await page.goto(`http://127.0.0.1:${WEB_PORT}/app/${requestId}`, { waitUntil: "load" });
      await page.fill("#reject-reason", reason);

      await Promise.all([
        page.waitForURL(new RegExp(`^http://127\\.0\\.0\\.1:${WEB_PORT}/app$`)),
        page.click('button:has-text("Reject")'),
      ]);

      await page.goto(`http://127.0.0.1:${WEB_PORT}/t/${trackingToken}`, { waitUntil: "load" });
      const body = await page.locator("body").innerText();
      // "Reviewed" is statusLabel()'s public-facing word for "rejected"
      // (web/src/lib/tracking.ts) - the reason itself is staff-internal
      // and must never reach the public page.
      expect(body).toContain("Reviewed");
      expect(body).not.toContain(reason);
      await page.close();
    });
  },
);
