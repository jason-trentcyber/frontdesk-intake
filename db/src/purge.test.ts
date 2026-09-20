import { randomUUID } from "node:crypto";
import { eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { purgeDemoOrgs, retentionHours } from "./purge.js";
import { actions, drafts, orgs, requests } from "./schema/index.js";
import { seedDatabase } from "./seed.js";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

// No Postgres needed - pure env parsing, always runs.
describe("retentionHours", () => {
  const KEY = "DEMO_PURGE_RETENTION_HOURS";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("defaults to 24 when unset", () => {
    delete process.env[KEY];
    expect(retentionHours()).toBe(24);
  });

  it("uses the env var when it's a positive number", () => {
    process.env[KEY] = "6";
    expect(retentionHours()).toBe(6);
  });

  it.each(["0", "-1", "not-a-number", ""])("throws on an invalid value (%s)", (value) => {
    process.env[KEY] = value;
    expect(() => retentionHours()).toThrow(/DEMO_PURGE_RETENTION_HOURS must be a positive number/);
  });
});

// Needs a live, migrated, seeded Postgres (both orgs, ADR-0018) - skips
// with a named reason rather than failing, same pattern as
// db/src/rls.test.ts, so `pnpm test` at the repo root stays green
// without Postgres running.
describe.skipIf(!hasEnv)(
  hasEnv
    ? "demo org purge (#28, F17)"
    : "demo org purge (#28, F17) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
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
        throw new Error(
          "expected seed data (bright-smile-dental, harbor-legal) - run `pnpm seed` first",
        );
      }
      demoOrgId = demo.id;
      otherOrgId = other.id;
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
      const rows = await ownerDb
        .select({ id: requests.id })
        .from(requests)
        .where(eq(requests.id, id));
      return rows.length > 0;
    }

    // Restores requests' real policy shape (db/src/schema/requests.ts:
    // one org_isolation policy, FOR ALL) exactly. Committed via ownerDb
    // (frontdesk owns the table - no special grant needed), not run
    // inside a transaction that gets rolled back: RLS enforcement is
    // per-role and per-committed-policy, so a transaction-local change on
    // one connection would never be visible to appDb's own (separate,
    // pooled) connections in the first place - narrowing has to be a
    // real committed change for the regression test below to observe it
    // through the same code path production actually uses. Idempotent
    // (IF EXISTS / only recreates what's missing) so it's safe to call
    // unconditionally from afterEach on every test, not just the one
    // that narrows the policy.
    async function restoreRequestsPolicy(): Promise<void> {
      await ownerDb.execute(sql`drop policy if exists org_isolation_select on requests`);
      await ownerDb.execute(sql`drop policy if exists org_isolation_insert on requests`);
      const existing = await ownerDb.execute<{ policyname: string }>(
        sql`select policyname from pg_policies where tablename = 'requests' and policyname = 'org_isolation'`,
      );
      if (existing.rows.length === 0) {
        await ownerDb.execute(sql`
          create policy org_isolation on requests for all to frontdesk_app
          using (org_id = current_org_id())
          with check (org_id = current_org_id())
        `);
      }
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
      // Belt and braces on top of the "no demo org" test's own
      // try/finally: this runs after every test regardless of outcome,
      // so even a crash inside that one test's try block can't leave
      // bright-smile-dental permanently misclassified for whatever runs
      // next in this file or a later `pnpm test`.
      await ownerDb.update(orgs).set({ isDemo: true }).where(eq(orgs.id, demoOrgId));
      // Same belt-and-braces reasoning, for the policy-narrowing
      // regression test below - a crash inside its try block must not
      // leave requests without a delete policy for every other org
      // (approve/reject in production also UPDATE requests) or every
      // later test in this file.
      await restoreRequestsPolicy();
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

    it("reports deletedCount from what the DELETE actually removed, not what the SELECT found - regression for the append-only trap on requests itself", async () => {
      const stale = await makeRequest(demoOrgId, { createdAt: hoursAgo(48) });

      // Reproduces, on requests itself, the exact append-only shape
      // drafts/actions already have today (org_isolation_select +
      // org_isolation_insert, no delete policy at all). Before the fix,
      // purgeOrgRequests inferred "deleted" from the ids the SELECT
      // found - under this policy the SELECT still finds `stale` every
      // iteration and the DELETE silently removes nothing, so the old
      // code both reports a false deletedCount and never terminates
      // (a full batch keeps getting "selected" forever). Confirmed this
      // test goes red on the pre-fix code (times out looping) and green
      // after (deletedCount: 0, stale survives) - see the PR body.
      await ownerDb.execute(sql`drop policy org_isolation on requests`);
      await ownerDb.execute(sql`
        create policy org_isolation_select on requests for select to frontdesk_app
        using (org_id = current_org_id())
      `);
      await ownerDb.execute(sql`
        create policy org_isolation_insert on requests for insert to frontdesk_app
        with check (org_id = current_org_id())
      `);

      try {
        const results = await purgeDemoOrgs(appDb, { cutoff: hoursAgo(24) });
        const demoResult = results.find((r) => r.orgId === demoOrgId);
        expect(demoResult?.deletedCount).toBe(0);
        expect(await requestExists(stale.id)).toBe(true);
      } finally {
        await restoreRequestsPolicy();
      }
    });

    it("purges every demo org independently when more than one exists", async () => {
      const [secondDemoOrg] = await ownerDb
        .insert(orgs)
        .values({
          slug: `purge-test-demo-${randomUUID()}`,
          name: "purge test demo org",
          isDemo: true,
        })
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
