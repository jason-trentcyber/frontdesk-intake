import { randomUUID } from "node:crypto";
import { createDb, drafts, requests, type Db } from "@frontdesk/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getTrackingView } from "./tracking";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

// Needs a live, migrated, seeded Postgres (both orgs, ADR-0018) - skips
// with a named reason rather than failing, same pattern as
// db/src/rls.test.ts and api/src/routes/requests.test.ts, so `pnpm test`
// at the repo root stays green without Postgres running.
describe.skipIf(!hasEnv)(
  hasEnv
    ? "getTrackingView (F2/F12, ADR-0027)"
    : "getTrackingView (F2/F12, ADR-0027) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let appDb: Db;
    let demoOrgId: string;
    let otherOrgId: string;
    const createdRequestIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      // getTrackingView must behave identically to how it runs in
      // production - through the RLS-bound frontdesk_app role, not the
      // table owner (which would silently pass even a broken org_id
      // filter, since RLS never applies to it).
      appDb = createDb(appUrl!);

      const orgs = await ownerDb.execute<{ id: string; slug: string }>(
        sql`select id, slug from orgs`,
      );
      const demo = orgs.rows.find((o) => o.slug === "bright-smile-dental");
      const other = orgs.rows.find((o) => o.slug === "harbor-legal");
      if (!demo || !other) {
        throw new Error(
          "expected seed data (bright-smile-dental, harbor-legal) - run `pnpm seed` first",
        );
      }
      demoOrgId = demo.id;
      otherOrgId = other.id;
    });

    afterEach(async () => {
      while (createdRequestIds.length > 0) {
        const id = createdRequestIds.pop()!;
        await ownerDb.delete(requests).where(eq(requests.id, id));
      }
    });

    async function makeRequest(
      orgId: string,
      overrides: Partial<typeof requests.$inferInsert> = {},
    ) {
      const [row] = await ownerDb
        .insert(requests)
        .values({
          orgId,
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

    it("unknown token -> not_found", async () => {
      const view = await getTrackingView(appDb, `no-such-token-${randomUUID()}`);
      expect(view).toEqual({ kind: "not_found" });
    });

    it.each([
      ["empty string", ""],
      ["sql-shaped input", "'; drop table requests; --"],
      ["very long garbage", "x".repeat(5000)],
    ])("malformed token (%s) -> not_found, same shape as unknown", async (_label, token) => {
      const view = await getTrackingView(appDb, token);
      expect(view).toEqual({ kind: "not_found" });
    });

    it.each(["received", "triaging", "needs_human"] as const)(
      "status %s -> status view, no reply text",
      async (status) => {
        const row = await makeRequest(demoOrgId, { status });
        const view = await getTrackingView(appDb, row.trackingToken);
        expect(view).toEqual({ kind: "status", status });
      },
    );

    it("status drafted with a real draft row present -> status view only; the draft body never appears anywhere in the result", async () => {
      const row = await makeRequest(demoOrgId, { status: "drafted" });
      const secretDraftBody = `UNAPPROVED-DRAFT-${randomUUID()}`;
      await ownerDb.insert(drafts).values({
        orgId: demoOrgId,
        requestId: row.id,
        version: 1,
        body: secretDraftBody,
        confidence: "0.900",
        model: "test",
        promptVersion: "test",
      });

      const view = await getTrackingView(appDb, row.trackingToken);

      expect(view).toEqual({ kind: "status", status: "drafted" });
      expect(JSON.stringify(view)).not.toContain(secretDraftBody);
    });

    it("status rejected -> status view", async () => {
      const row = await makeRequest(demoOrgId, { status: "rejected" });
      const view = await getTrackingView(appDb, row.trackingToken);
      expect(view).toEqual({ kind: "status", status: "rejected" });
    });

    it("status approved -> approved view with the reply_text snapshot", async () => {
      const replyText = `approved reply ${randomUUID()}`;
      const row = await makeRequest(demoOrgId, { status: "approved", replyText });
      const view = await getTrackingView(appDb, row.trackingToken);
      expect(view).toEqual({ kind: "approved", replyText });
    });

    it("a token from org A never surfaces a row from org B, even if the code used the wrong org id (RLS backstop)", async () => {
      const rowA = await makeRequest(demoOrgId, { status: "approved", replyText: "org A reply" });

      // Simulates the bug this test exists to catch: something upstream
      // passes org B's id with org A's request id. Same transaction-local
      // set_config forOrg() itself uses, pinned to one connection by
      // appDb.transaction() - RLS must still return zero rows for a
      // request that actually belongs to org A, regardless of what the
      // application-level org_id filter does.
      const rows = await appDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${otherOrgId}, true)`);
        const res = await tx.execute<{ id: string }>(
          sql`select id from requests where id = ${rowA.id}`,
        );
        return res.rows;
      });
      expect(rows).toHaveLength(0);
    });
  },
);
