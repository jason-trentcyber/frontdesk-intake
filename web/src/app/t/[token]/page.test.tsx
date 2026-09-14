import { randomUUID } from "node:crypto";
import { createDb, drafts, requests, type Db } from "@frontdesk/db";
import { eq, sql } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import TrackingPage, { dynamic, metadata, runtime } from "./page";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

// This suite needs DATABASE_APP_URL because the page itself resolves its
// own db handle via getDb()/loadEnv() (web/src/lib/db.ts), the same way
// it would in production - unlike tracking.test.ts, which passes a db
// handle in directly and can exercise the owner role for setup too.
describe.skipIf(!hasEnv)(
  hasEnv ? "/t/[token] page" : "/t/[token] page [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let demoOrgId: string;
    const createdRequestIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      const orgs = await ownerDb.execute<{ id: string; slug: string }>(
        sql`select id, slug from orgs where slug = 'bright-smile-dental'`,
      );
      const demo = orgs.rows[0];
      if (!demo) throw new Error("expected seed data - run `pnpm seed` first");
      demoOrgId = demo.id;
    });

    afterEach(async () => {
      while (createdRequestIds.length > 0) {
        const id = createdRequestIds.pop()!;
        await ownerDb.delete(requests).where(eq(requests.id, id));
      }
    });

    async function makeRequest(overrides: Partial<typeof requests.$inferInsert> = {}) {
      const [row] = await ownerDb
        .insert(requests)
        .values({
          orgId: demoOrgId,
          source: "form",
          subject: "test subject",
          body: "test body",
          trackingToken: `test-${randomUUID()}`,
          status: "received",
          ...overrides,
        })
        .returning();
      if (!row) throw new Error("failed to insert test request");
      createdRequestIds.push(row.id);
      return row;
    }

    function renderPage(token: string) {
      return TrackingPage({ params: Promise.resolve({ token }) });
    }

    it("segment config: Node runtime, never cached, noindex", () => {
      expect(runtime).toBe("nodejs");
      expect(dynamic).toBe("force-dynamic");
      expect(metadata).toEqual({ robots: { index: false, follow: false } });
    });

    it("unknown token -> Next's notFound() (404), not a rendered page", async () => {
      // Next 16's notFound() throws with this digest (older versions used
      // "NEXT_NOT_FOUND"); Next's own router, not this test, is what maps
      // it to an actual 404 response - asserting the digest is the
      // closest a call to the bare component gets to that behavior.
      await expect(renderPage(`no-such-token-${randomUUID()}`)).rejects.toMatchObject({
        digest: "NEXT_HTTP_ERROR_FALLBACK;404",
      });
    });

    it("a drafted request with a real, distinctive draft body -> the rendered page never contains that body", async () => {
      const row = await makeRequest({ status: "drafted" });
      const secretDraftBody = `UNAPPROVED-DRAFT-TEXT-${randomUUID()}`;
      await ownerDb.insert(drafts).values({
        orgId: demoOrgId,
        requestId: row.id,
        version: 1,
        body: secretDraftBody,
        confidence: "0.900",
        model: "test",
        promptVersion: "test",
      });

      const html = renderToStaticMarkup(await renderPage(row.trackingToken));

      expect(html).not.toContain(secretDraftBody);
      expect(html).toContain("In review");
    });

    it("an approved request -> the rendered page contains the reply_text snapshot", async () => {
      const replyText = `approved reply body ${randomUUID()}`;
      const row = await makeRequest({ status: "approved", replyText });

      const html = renderToStaticMarkup(await renderPage(row.trackingToken));

      expect(html).toContain(replyText);
    });
  },
);
