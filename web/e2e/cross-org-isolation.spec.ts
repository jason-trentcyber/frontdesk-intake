import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import {
  authSessions,
  authUsers,
  createDb,
  forOrg,
  orgMembers,
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

const WEB_PORT = 3412;

// Not a real secret (gitleaks, docs/AI-GOVERNANCE.md): AUTH_SECRET only
// needs to be *present* for Auth.js to boot in production mode
// (NODE_ENV=production, set internally by the standalone build) - this
// test never exercises anything AUTH_SECRET actually signs, since the
// session it authenticates with is a row seeded directly into
// auth.sessions (Trap 5 below), not a token Auth.js itself issued.
const TEST_AUTH_SECRET = "e2e-test-only-not-a-real-secret-6f1c9a2d";

/**
 * #26's core acceptance criterion, proved with a real browser: two
 * isolated browser contexts, each authenticated as a different org's
 * staff member, and org A's session cannot read org B's data.
 *
 * Trap 5 (ADR-0031/ADR-0030): Playwright cannot drive a real Google/
 * GitHub OAuth consent screen, and this repo's production auth config
 * gets no test-only Credentials provider to work around that. Instead:
 * seed a row directly into auth.sessions for a seeded org_members email
 * (via @frontdesk/db, same owner-role connection every other db-backed
 * e2e/test file in this repo already uses) and hand each browser
 * context a storageState carrying that session's cookie - the same
 * cookie a real sign-in would have set, just placed there directly.
 */
test.describe(
  hasEnv
    ? "cross-org isolation (#26)"
    : "cross-org isolation (#26) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    test.skip(!hasEnv);

    let ownerDb: Db;
    let orgAId: string;
    let orgBId: string;
    let webProcess: ChildProcess;
    let browser: Browser;
    let contextA: BrowserContext;
    let contextB: BrowserContext;

    const orgASubject = `cross-org-isolation-${randomUUID()}-org-a-only`;
    const orgBSubject = `cross-org-isolation-${randomUUID()}-org-b-only`;
    const createdRequestIds: string[] = [];
    const createdSessionTokens: string[] = [];
    const createdUserIds: string[] = [];

    function ownerEmailFor(orgSlug: string): string {
      // Mirrors db/src/seed.ts's ownerEmailFor(): org_members.email is
      // globally unique (ADR-0018), so both orgs' seeded owners are
      // plus-addressed off SEED_OWNER_EMAIL rather than sharing one
      // literal address.
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
      await ownerDb.insert(authSessions).values({
        sessionToken,
        userId: user.id,
        expires: new Date(Date.now() + 60 * 60 * 1000),
      });
      createdSessionTokens.push(sessionToken);
      return sessionToken;
    }

    function storageStateFor(sessionToken: string) {
      return {
        cookies: [
          {
            name: "authjs.session-token",
            value: sessionToken,
            domain: "127.0.0.1",
            path: "/",
            httpOnly: true,
            secure: false,
            sameSite: "Lax" as const,
            expires: Math.floor(Date.now() / 1000) + 60 * 60,
          },
        ],
        origins: [],
      };
    }

    test.beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      const [orgA] = await ownerDb
        .select({ id: orgs.id, slug: orgs.slug })
        .from(orgs)
        .where(eq(orgs.slug, "bright-smile-dental"));
      const [orgB] = await ownerDb
        .select({ id: orgs.id, slug: orgs.slug })
        .from(orgs)
        .where(eq(orgs.slug, "harbor-legal"));
      if (!orgA || !orgB)
        throw new Error(
          "expected both seeded orgs (bright-smile-dental, harbor-legal) - run `pnpm seed` first",
        );
      orgAId = orgA.id;
      orgBId = orgB.id;

      // One distinctly-named, self-inserted request per org (not relying
      // on db/src/seed.ts's demo-only fixture data, which harbor-legal
      // never gets) so this test proves isolation on data it controls.
      const requestAId = await forOrg(ownerDb, orgAId, async (tx, orgId) => {
        const [row] = await tx
          .insert(requests)
          .values({
            orgId,
            source: "form",
            subject: orgASubject,
            body: "org A body",
            trackingToken: `tok-${randomUUID()}`,
          })
          .returning({ id: requests.id });
        if (!row) throw new Error("org A insert returned no row");
        return row.id;
      });
      createdRequestIds.push(requestAId);

      const requestBId = await forOrg(ownerDb, orgBId, async (tx, orgId) => {
        const [row] = await tx
          .insert(requests)
          .values({
            orgId,
            source: "form",
            subject: orgBSubject,
            body: "org B body",
            trackingToken: `tok-${randomUUID()}`,
          })
          .returning({ id: requests.id });
        if (!row) throw new Error("org B insert returned no row");
        return row.id;
      });
      createdRequestIds.push(requestBId);

      const sessionTokenA = await seedSessionFor(ownerEmailFor("bright-smile-dental"));
      const sessionTokenB = await seedSessionFor(ownerEmailFor("harbor-legal"));

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
          API_ORIGIN: "http://127.0.0.1:1", // unused by /app; not exercised here
          TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
        },
      });
      await waitForHealthy(`http://127.0.0.1:${WEB_PORT}/healthz`);

      browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
      contextA = await browser.newContext({ storageState: storageStateFor(sessionTokenA) });
      contextB = await browser.newContext({ storageState: storageStateFor(sessionTokenB) });
    });

    test.afterAll(async () => {
      await contextA?.close();
      await contextB?.close();
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

    test("org A's authenticated session sees org A's queue, not org B's", async () => {
      const page = await contextA.newPage();
      await page.goto(`http://127.0.0.1:${WEB_PORT}/app`, { waitUntil: "networkidle" });
      const body = await page.locator("body").innerText();
      expect(body).toContain(orgASubject);
      expect(body).not.toContain(orgBSubject);
      await page.close();
    });

    test("org B's authenticated session sees org B's queue, not org A's", async () => {
      const page = await contextB.newPage();
      await page.goto(`http://127.0.0.1:${WEB_PORT}/app`, { waitUntil: "networkidle" });
      const body = await page.locator("body").innerText();
      expect(body).toContain(orgBSubject);
      expect(body).not.toContain(orgASubject);
      await page.close();
    });

    test("removing the org_members row takes effect on the very next request - no sign-out", async () => {
      const email = ownerEmailFor("bright-smile-dental");
      const page = await contextA.newPage();

      await page.goto(`http://127.0.0.1:${WEB_PORT}/app`, { waitUntil: "networkidle" });
      await expect(page.locator("body")).toContainText(orgASubject);

      // Same seeded org_members row db/src/seed.ts creates - captured so
      // it can be restored exactly, since other suites (db/src/rls.test.ts)
      // assume this owner still exists.
      const [membership] = await ownerDb
        .select()
        .from(orgMembers)
        .where(eq(orgMembers.email, email));
      if (!membership) throw new Error(`expected a seeded org_members row for ${email}`);

      try {
        await ownerDb.delete(orgMembers).where(eq(orgMembers.id, membership.id));

        // Same browser context, same session cookie, no sign-out and no
        // new sign-in - only the org_members row changed. ADR-0031 §3:
        // membership is re-resolved from org_members on every request, so
        // this takes effect on the very next one.
        await page.goto(`http://127.0.0.1:${WEB_PORT}/app`, { waitUntil: "networkidle" });
        const bodyAfterRemoval = await page.locator("body").innerText();
        expect(bodyAfterRemoval).not.toContain(orgASubject);
        expect(bodyAfterRemoval.toLowerCase()).toContain("not a member");
      } finally {
        await ownerDb.insert(orgMembers).values({
          orgId: membership.orgId,
          email: membership.email,
          role: membership.role,
        });
      }

      // Restored - the same session, previously locked out, sees org A's
      // data again with still no sign-out in between.
      await page.goto(`http://127.0.0.1:${WEB_PORT}/app`, { waitUntil: "networkidle" });
      await expect(page.locator("body")).toContainText(orgASubject);

      await page.close();
    });

    /**
     * CVE-2025-29927 (ADR-0031 §Context, §5): a crafted x-middleware-
     * subrequest header made Next's middleware skip entirely on affected
     * versions. This repo's Next version is patched, so this header does
     * not reproduce that bug at the framework level - what this test
     * actually proves is the *design* lesson: even an unauthenticated
     * request carrying that header gets no protected content, because
     * /app/layout.tsx's real check runs independently of proxy.ts and
     * does not trust it to have already decided anything. No session
     * cookie at all here - the point is that the header alone buys
     * nothing.
     */
    test("a crafted x-middleware-subrequest header does not bypass the layout guard", async () => {
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/app`, {
        headers: { "x-middleware-subrequest": "proxy" },
        redirect: "follow",
      });
      const body = await res.text();
      expect(body).not.toContain(orgASubject);
      expect(body).not.toContain(orgBSubject);
      expect(body.toLowerCase()).not.toContain("<table");
    });
  },
);
