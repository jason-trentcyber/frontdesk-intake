import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { purgeDemoOrgs } from "./purge.js";
import { actions, drafts, orgs, requests } from "./schema/index.js";
import { seedDatabase } from "./seed.js";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

// Needs a live, migrated, seeded Postgres (both orgs, ADR-0018) - skips
// with a named reason rather than failing, same pattern as
// db/src/rls.test.ts, so `pnpm test` at the repo root stays green
// without Postgres running.
describe.skipIf(!hasEnv)(
  hasEnv ? "demo org purge (#28, F17)" : "demo org purge (#28, F17) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let appDb: Db;
    let demoOrgId: string;
    let otherOrgId: string;
    const createdRequestIds: string[] = [];
    const createdOrgIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      // The purge runs as frontdesk_app in production (ADR-0017) - the
      // whole point of these tests is proving it works under RLS, not
      // just against a connection that bypasses it.
      appDb = createDb(appUrl!);
      const rows = await ownerDb.select({ id: orgs.id, slug: orgs.slug }).from(orgs);
      const demo = rows.find((o) => o.slug === "bright-smile-dental");
      const other = rows.find((o) => o.slug === "harbor-legal");
      if (!demo || !other) {
        throw new Error("expected seed data (bright-smile-dental, harbor-legal) - run `pnpm seed` first");
      }
      demoOrgId = demo.id;
      otherOrgId = other.id;
    });

    async function makeRequest(orgId: string, overrides: Partial<typeof requests.$inferInsert> = {}) {
      const [row] = await ownerDb
        .insert(requests)
        .values({
          orgId,
          source: "form",
          subject: "purge test",
          body: "purge test body",
          trackingToken: `purge-test-${randomUUID()}`,
          status: "received",
          ...overrides,
        })
        .returning();
      if (!row) throw new Error("failed to insert test request");
      createdRequestIds.push(row.id);
      return row;
    }

    async function requestExists(id: string): Promise<boolean> {
      const rows = await ownerDb.select({ id: requests.id }).from(requests).where(eq(requests.id, id));
      return rows.length > 0;
    }

    afterEach(async () => {
      // Cleans up anything a test's own assertions didn't already prove
      // the purge removed (e.g. the "survives" fixtures, or a fixture
      // left behind by a failed assertion) - deleting an id the purge
      // already removed is a no-op, not an error.
      if (createdRequestIds.length > 0) {
        await ownerDb.delete(requests).where(inArray(requests.id, createdRequestIds));
        createdRequestIds.length = 0;
      }
      if (createdOrgIds.length > 0) {
        await ownerDb.delete(orgs).where(inArray(orgs.id, createdOrgIds));
        createdOrgIds.length = 0;
      }
      // Real seed rows for the real demo org may have been swept up as a
      // side effect of exercising the real cutoff semantics against it
      // (deliberate - see the "purges stale requests" test below).
      // seedDatabase is idempotent and create-if-missing by natural key
      // (ADR-0018 acceptance 4), so this restores anything this suite
      // collaterally purged without touching anything it didn't.
      await seedDatabase(ownerDb);
    });

    it("no demo org configured -> returns an empty array without assuming exactly one row", async () => {
      // The only way to observe a true zero-demo-org state without a
      // second cluster is to make the real one not count, briefly - the
      // finally block below runs even if an assertion throws, and no
      // other test in this file (or db/src/rls.test.ts, which looks up
      // bright-smile-dental by slug, never by is_demo) depends on this
      // flag while it's flipped.
      await ownerDb.update(orgs).set({ isDemo: false }).where(eq(orgs.id, demoOrgId));
      try {
        const results = await purgeDemoOrgs(appDb, { cutoff: hoursAgo(24) });
        expect(results).toEqual([]);
      } finally {
        await ownerDb.update(orgs).set({ isDemo: true }).where(eq(orgs.id, demoOrgId));
      }
    });

    it("purges a demo-org request older than the cutoff, cascading to its drafts and actions, and leaves a fresher one alone", async () => {
      const stale = await makeRequest(demoOrgId, { createdAt: hoursAgo(48) });
      const fresh = await makeRequest(demoOrgId, { createdAt: hoursAgo(1) });

      const [draft] = await ownerDb
        .insert(drafts)
        .values({
          orgId: demoOrgId,
          requestId: stale.id,
          version: 1,
          body: "purge test draft",
          confidence: "0.500",
          model: "test",
          promptVersion: "test",
        })
        .returning();
      const [action] = await ownerDb
        .insert(actions)
        .values({
          orgId: demoOrgId,
          requestId: stale.id,
          actorEmail: "staff@example.com",
          kind: "approve",
        })
        .returning();
      if (!draft || !action) throw new Error("failed to insert test draft/action");

      await purgeDemoOrgs(appDb, { cutoff: hoursAgo(24) });

      expect(await requestExists(stale.id)).toBe(false);
      expect(await requestExists(fresh.id)).toBe(true);

      const draftRows = await ownerDb.select().from(drafts).where(eq(drafts.id, draft.id));
      const actionRows = await ownerDb.select().from(actions).where(eq(actions.id, action.id));
      expect(draftRows).toEqual([]);
      expect(actionRows).toEqual([]);
    });

    it("purges across multiple batches until none remain", async () => {
      const staleRows = await Promise.all(
        Array.from({ length: 5 }, () => makeRequest(demoOrgId, { createdAt: hoursAgo(48) })),
      );

      const results = await purgeDemoOrgs(appDb, { cutoff: hoursAgo(24), batchSize: 2 });

      const demoResult = results.find((r) => r.orgId === demoOrgId);
      expect(demoResult?.deletedCount).toBeGreaterThanOrEqual(5);
      for (const row of staleRows) {
        expect(await requestExists(row.id)).toBe(false);
      }
    });

    it("a stale request in the private org (harbor-legal) survives the purge untouched", async () => {
      const privateStale = await makeRequest(otherOrgId, { createdAt: hoursAgo(48) });

      await purgeDemoOrgs(appDb, { cutoff: hoursAgo(24) });

      expect(await requestExists(privateStale.id)).toBe(true);
    });

    it("purges every demo org independently when more than one exists", async () => {
      const [secondDemoOrg] = await ownerDb
        .insert(orgs)
        .values({ slug: `purge-test-demo-${randomUUID()}`, name: "purge test demo org", isDemo: true })
        .returning({ id: orgs.id });
      if (!secondDemoOrg) throw new Error("failed to insert second demo org");
      createdOrgIds.push(secondDemoOrg.id);

      const staleInSecond = await makeRequest(secondDemoOrg.id, { createdAt: hoursAgo(48) });

      const results = await purgeDemoOrgs(appDb, { cutoff: hoursAgo(24) });

      expect(results.length).toBeGreaterThanOrEqual(2);
      const secondResult = results.find((r) => r.orgId === secondDemoOrg.id);
      expect(secondResult).toMatchObject({ orgId: secondDemoOrg.id, deletedCount: 1 });
      expect(await requestExists(staleInSecond.id)).toBe(false);
    });
  },
);
