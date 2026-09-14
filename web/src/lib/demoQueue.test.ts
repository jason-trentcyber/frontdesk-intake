import { randomUUID } from "node:crypto";
import { createDb, drafts, orgs, requests, type Db } from "@frontdesk/db";
import { eq, inArray } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getDemoOrg, getDemoQueue } from "./demoQueue";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

describe.skipIf(!hasEnv)(
  hasEnv ? "demo queue (F16, ADR-0007)" : "demo queue (F16, ADR-0007) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let appDb: Db;
    const createdOrgIds: string[] = [];
    const createdRequestIds: string[] = [];

    beforeAll(() => {
      ownerDb = createDb(ownerUrl!);
      // getDemoQueue is what production actually queries with - RLS
      // enforcement, not just the app-level org_id filter, is the thing
      // under test here as much as the shape of the result.
      appDb = createDb(appUrl!);
    });

    afterEach(async () => {
      if (createdRequestIds.length > 0) {
        await ownerDb.delete(requests).where(inArray(requests.id, createdRequestIds));
        createdRequestIds.length = 0;
      }
      if (createdOrgIds.length > 0) {
        await ownerDb.delete(orgs).where(inArray(orgs.id, createdOrgIds));
        createdOrgIds.length = 0;
      }
    });

    async function makeOrg(): Promise<string> {
      const [org] = await ownerDb
        .insert(orgs)
        .values({ slug: `demo-queue-test-${randomUUID()}`, name: "demo queue test org", isDemo: true })
        .returning({ id: orgs.id });
      if (!org) throw new Error("failed to insert test org");
      createdOrgIds.push(org.id);
      return org.id;
    }

    async function makeRequest(orgId: string, overrides: Partial<typeof requests.$inferInsert> = {}) {
      const [row] = await ownerDb
        .insert(requests)
        .values({
          orgId,
          source: "form",
          subject: "demo queue test subject",
          body: "demo queue test body",
          trackingToken: `demo-queue-test-${randomUUID()}`,
          status: "received",
          ...overrides,
        })
        .returning();
      if (!row) throw new Error("failed to insert test request");
      createdRequestIds.push(row.id);
      return row;
    }

    it("getDemoOrg finds a real seeded org marked is_demo, never by slug", async () => {
      const realDemoOrgs = await ownerDb.select({ id: orgs.id }).from(orgs).where(eq(orgs.isDemo, true));
      if (realDemoOrgs.length === 0) {
        throw new Error("expected at least one is_demo org - run `pnpm seed` first");
      }

      const found = await getDemoOrg(appDb);

      expect(found).not.toBeNull();
      expect(realDemoOrgs.map((o) => o.id)).toContain(found!.id);
    });

    it("an org with no requests yet -> an empty queue, not an error", async () => {
      const orgId = await makeOrg();

      const queue = await getDemoQueue(appDb, orgId);

      expect(queue).toEqual([]);
    });

    it("orders newest first and reflects each request's actual status", async () => {
      const orgId = await makeOrg();
      const older = await makeRequest(orgId, {
        subject: "older",
        status: "received",
        createdAt: new Date(Date.now() - 60_000),
      });
      const newer = await makeRequest(orgId, {
        subject: "newer",
        status: "triaging",
        createdAt: new Date(),
      });

      const queue = await getDemoQueue(appDb, orgId);

      expect(queue).toEqual([
        { kind: "status", id: newer.id, subject: "newer", status: "triaging" },
        { kind: "status", id: older.id, subject: "older", status: "received" },
      ]);
    });

    it("an approved request contributes its reply_text; a request in any other status never does", async () => {
      const orgId = await makeOrg();
      const approved = await makeRequest(orgId, { status: "approved", replyText: "the approved reply" });

      const queue = await getDemoQueue(appDb, orgId);

      expect(queue).toEqual([{ kind: "approved", id: approved.id, subject: approved.subject, replyText: "the approved reply" }]);
    });

    it("requesterName/requesterEmail never appear anywhere in the result, even for a drafted request with a real draft present", async () => {
      const orgId = await makeOrg();
      const secretName = `SECRET-NAME-${randomUUID()}`;
      const secretEmail = `secret-${randomUUID()}@example.com`;
      const secretDraftBody = `SECRET-UNAPPROVED-DRAFT-${randomUUID()}`;
      const row = await makeRequest(orgId, {
        status: "drafted",
        requesterName: secretName,
        requesterEmail: secretEmail,
      });
      await ownerDb.insert(drafts).values({
        orgId,
        requestId: row.id,
        version: 1,
        body: secretDraftBody,
        confidence: "0.500",
        model: "test",
        promptVersion: "test",
      });

      const queue = await getDemoQueue(appDb, orgId);

      expect(queue).toEqual([{ kind: "status", id: row.id, subject: row.subject, status: "drafted" }]);
      const serialized = JSON.stringify(queue);
      expect(serialized).not.toContain(secretName);
      expect(serialized).not.toContain(secretEmail);
      expect(serialized).not.toContain(secretDraftBody);
    });

    it("a different org's requests never appear in this org's queue (RLS + explicit org_id)", async () => {
      const orgA = await makeOrg();
      const orgB = await makeOrg();
      await makeRequest(orgA, { subject: "org A's request" });
      await makeRequest(orgB, { subject: "org B's request" });

      const queueA = await getDemoQueue(appDb, orgA);

      expect(queueA).toHaveLength(1);
      expect(queueA[0]?.subject).toBe("org A's request");
    });
  },
);
