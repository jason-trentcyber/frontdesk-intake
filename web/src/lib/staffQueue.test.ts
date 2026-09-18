import { randomUUID } from "node:crypto";
import { createDb, requests, type Db } from "@frontdesk/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getStaffQueue, getStaffQueueFilterOptions } from "./staffQueue";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

// Needs a live, migrated, seeded Postgres (both orgs) - skips with a
// named reason rather than failing, same pattern as
// web/src/lib/tracking.test.ts, so `pnpm test` at the repo root stays
// green without Postgres running.
describe.skipIf(!hasEnv)(
  hasEnv
    ? "getStaffQueue (#26)"
    : "getStaffQueue (#26) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let appDb: Db;
    let demoOrgId: string;
    let otherOrgId: string;
    const createdRequestIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      // Through the RLS-bound frontdesk_app role, like getTrackingView's
      // test - the table owner would silently pass even a broken org_id
      // filter, since RLS never applies to it.
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

    it("returns only the given org's requests, even though both orgs have rows", async () => {
      const onlyInDemoSubject = `staff-queue-demo-only-${randomUUID()}`;
      const onlyInOtherSubject = `staff-queue-other-only-${randomUUID()}`;

      const [demoRow] = await ownerDb
        .insert(requests)
        .values({
          orgId: demoOrgId,
          source: "form",
          subject: onlyInDemoSubject,
          body: "x",
          trackingToken: `tok-${randomUUID()}`,
        })
        .returning();
      const [otherRow] = await ownerDb
        .insert(requests)
        .values({
          orgId: otherOrgId,
          source: "form",
          subject: onlyInOtherSubject,
          body: "x",
          trackingToken: `tok-${randomUUID()}`,
        })
        .returning();
      if (!demoRow || !otherRow) throw new Error("failed to insert test requests");
      createdRequestIds.push(demoRow.id, otherRow.id);

      const demoQueue = await getStaffQueue(appDb, demoOrgId);
      expect(demoQueue.some((r) => r.subject === onlyInDemoSubject)).toBe(true);
      expect(demoQueue.some((r) => r.subject === onlyInOtherSubject)).toBe(false);

      const otherQueue = await getStaffQueue(appDb, otherOrgId);
      expect(otherQueue.some((r) => r.subject === onlyInOtherSubject)).toBe(true);
      expect(otherQueue.some((r) => r.subject === onlyInDemoSubject)).toBe(false);
    });

    it("F10: status filter narrows the result to only matching statuses", async () => {
      const receivedSubject = `staff-queue-status-received-${randomUUID()}`;
      const rejectedSubject = `staff-queue-status-rejected-${randomUUID()}`;

      const [receivedRow] = await ownerDb
        .insert(requests)
        .values({
          orgId: demoOrgId,
          source: "form",
          subject: receivedSubject,
          body: "x",
          trackingToken: `tok-${randomUUID()}`,
          status: "received",
        })
        .returning();
      const [rejectedRow] = await ownerDb
        .insert(requests)
        .values({
          orgId: demoOrgId,
          source: "form",
          subject: rejectedSubject,
          body: "x",
          trackingToken: `tok-${randomUUID()}`,
          status: "rejected",
        })
        .returning();
      if (!receivedRow || !rejectedRow) throw new Error("failed to insert test requests");
      createdRequestIds.push(receivedRow.id, rejectedRow.id);

      const filtered = await getStaffQueue(appDb, demoOrgId, { status: ["received"] });
      expect(filtered.some((r) => r.subject === receivedSubject)).toBe(true);
      expect(filtered.some((r) => r.subject === rejectedSubject)).toBe(false);
    });

    it("F10: lane filter narrows the result to only matching lanes", async () => {
      const billingSubject = `staff-queue-lane-billing-${randomUUID()}`;
      const clinicalSubject = `staff-queue-lane-clinical-${randomUUID()}`;

      const [billingRow] = await ownerDb
        .insert(requests)
        .values({
          orgId: demoOrgId,
          source: "form",
          subject: billingSubject,
          body: "x",
          trackingToken: `tok-${randomUUID()}`,
          lane: "billing",
        })
        .returning();
      const [clinicalRow] = await ownerDb
        .insert(requests)
        .values({
          orgId: demoOrgId,
          source: "form",
          subject: clinicalSubject,
          body: "x",
          trackingToken: `tok-${randomUUID()}`,
          lane: "clinical",
        })
        .returning();
      if (!billingRow || !clinicalRow) throw new Error("failed to insert test requests");
      createdRequestIds.push(billingRow.id, clinicalRow.id);

      const filtered = await getStaffQueue(appDb, demoOrgId, { lane: ["billing"] });
      expect(filtered.some((r) => r.subject === billingSubject)).toBe(true);
      expect(filtered.some((r) => r.subject === clinicalSubject)).toBe(false);
    });

    it("F10: filter options come from the org's own settings, and two orgs differ", async () => {
      const demoOptions = await getStaffQueueFilterOptions(appDb, demoOrgId);
      const otherOptions = await getStaffQueueFilterOptions(appDb, otherOrgId);

      // db/src/seed.ts's two orgs use different category/lane vocabularies
      // - if this function ever regressed to a hardcoded array, both
      // would come back identical.
      expect(demoOptions.categories).not.toEqual(otherOptions.categories);
      expect(demoOptions.lanes.length).toBeGreaterThan(0);
      expect(demoOptions.statuses).toContain("needs_human");
    });
  },
);
