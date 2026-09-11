import { randomUUID } from "node:crypto";
import { apiKeys, createDb, requests, type Db } from "@frontdesk/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashApiKey } from "../api-key.js";
import { buildApp } from "../app.js";
import type { Queue, TriageMessage } from "../queue/index.js";
import type { TurnstileVerifier } from "../turnstile.js";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

class FakeQueue implements Queue<TriageMessage> {
  sent: TriageMessage[] = [];
  async send(payload: TriageMessage): Promise<string> {
    this.sent.push(payload);
    return randomUUID();
  }
  async receive(): Promise<never[]> {
    return [];
  }
  async ack(): Promise<void> {}
  async nack(): Promise<void> {}
  async deadLetter(): Promise<void> {}
}

// Needs a live, migrated, seeded Postgres (both orgs, ADR-0018) - skips
// with a named reason rather than failing, same pattern as
// db/src/rls.test.ts, so `pnpm test` at the repo root stays green
// without Postgres running.
describe.skipIf(!hasEnv)(
  hasEnv
    ? "POST /api/v1/orgs/:slug/requests"
    : "POST /api/v1/orgs/:slug/requests [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let appDb: Db;
    let demoOrgId: string;
    let otherOrgSlug: string;
    let apiKeyPlain: string;
    let apiKeyId: string;
    let revokedKeyPlain: string;
    let revokedKeyId: string;

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
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
      otherOrgSlug = other.slug;

      apiKeyPlain = `test-${randomUUID()}`;
      const [key] = await ownerDb
        .insert(apiKeys)
        .values({
          orgId: demoOrgId,
          keyHash: hashApiKey(apiKeyPlain),
          prefix: apiKeyPlain.slice(0, 8),
          name: "contract-test",
        })
        .returning({ id: apiKeys.id });
      if (!key) throw new Error("failed to seed API key");
      apiKeyId = key.id;

      revokedKeyPlain = `test-revoked-${randomUUID()}`;
      const [revoked] = await ownerDb
        .insert(apiKeys)
        .values({
          orgId: demoOrgId,
          keyHash: hashApiKey(revokedKeyPlain),
          prefix: revokedKeyPlain.slice(0, 8),
          name: "contract-test-revoked",
          revokedAt: new Date(),
        })
        .returning({ id: apiKeys.id });
      if (!revoked) throw new Error("failed to seed revoked API key");
      revokedKeyId = revoked.id;
    });

    afterAll(async () => {
      await ownerDb.delete(apiKeys).where(eq(apiKeys.id, apiKeyId));
      await ownerDb.delete(apiKeys).where(eq(apiKeys.id, revokedKeyId));
    });

    function buildTestApp(verifyTurnstile: TurnstileVerifier) {
      const queue = new FakeQueue();
      const app = buildApp({
        db: appDb,
        queue,
        verifyTurnstile,
        publicWebOrigin: "https://frontdesk.jtrent.dev",
      });
      return { app, queue };
    }

    const alwaysTrue: TurnstileVerifier = async () => true;
    const alwaysFalse: TurnstileVerifier = async () => false;

    it("valid API key -> 201, a requests row exists, the queue gets {orgId, requestId}", async () => {
      const { app, queue } = buildTestApp(alwaysTrue);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/bright-smile-dental/requests",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
        payload: { subject: "test subject", body: "test body" },
      });
      expect(res.statusCode).toBe(201);
      const json = res.json() as { trackingToken: string; trackingUrl: string };
      expect(json.trackingToken).toBeTruthy();
      expect(json.trackingUrl).toBe(`https://frontdesk.jtrent.dev/t/${json.trackingToken}`);

      const [row] = await ownerDb
        .select()
        .from(requests)
        .where(eq(requests.trackingToken, json.trackingToken));
      expect(row).toBeDefined();
      expect(row?.orgId).toBe(demoOrgId);
      expect(row?.source).toBe("api");

      expect(queue.sent).toEqual([{ orgId: demoOrgId, requestId: row?.id }]);

      await ownerDb.delete(requests).where(eq(requests.id, row!.id));
    });

    it("wrong API key -> 401 problem+json", async () => {
      const { app } = buildTestApp(alwaysTrue);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/bright-smile-dental/requests",
        headers: { authorization: "Bearer not-a-real-key" },
        payload: { subject: "s", body: "b" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["content-type"]).toContain("application/problem+json");
      expect(res.json()).toMatchObject({ status: 401 });
    });

    it("revoked API key -> 401", async () => {
      const { app } = buildTestApp(alwaysTrue);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/bright-smile-dental/requests",
        headers: { authorization: `Bearer ${revokedKeyPlain}` },
        payload: { subject: "s", body: "b" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("valid key, wrong slug -> 404 (not 403)", async () => {
      const { app } = buildTestApp(alwaysTrue);
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/orgs/${otherOrgSlug}/requests`,
        headers: { authorization: `Bearer ${apiKeyPlain}` },
        payload: { subject: "s", body: "b" },
      });
      expect(res.statusCode).toBe(404);
      expect(res.headers["content-type"]).toContain("application/problem+json");
    });

    it("both an API key and a turnstile response -> 400", async () => {
      const { app } = buildTestApp(alwaysTrue);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/bright-smile-dental/requests",
        headers: { authorization: `Bearer ${apiKeyPlain}` },
        payload: { subject: "s", body: "b", "cf-turnstile-response": "token" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("neither an API key nor a turnstile response -> 400", async () => {
      const { app } = buildTestApp(alwaysTrue);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/bright-smile-dental/requests",
        payload: { subject: "s", body: "b" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("turnstile success -> 201", async () => {
      const { app, queue } = buildTestApp(alwaysTrue);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/bright-smile-dental/requests",
        payload: { subject: "s", body: "b", "cf-turnstile-response": "token" },
      });
      expect(res.statusCode).toBe(201);
      const json = res.json() as { trackingToken: string };
      expect(queue.sent).toHaveLength(1);
      await ownerDb.delete(requests).where(eq(requests.trackingToken, json.trackingToken));
    });

    it("turnstile failure -> 403", async () => {
      const { app } = buildTestApp(alwaysFalse);
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/orgs/bright-smile-dental/requests",
        payload: { subject: "s", body: "b", "cf-turnstile-response": "token" },
      });
      expect(res.statusCode).toBe(403);
    });

    // Body validation is a DIFFERENT 400 from the auth-mode guard above:
    // that one rejects the request before looking at the body at all.
    // These use the turnstile path so auth passes and the schema is what
    // fails. Nothing reaches the database or the queue.
    describe("invalid body -> 400", () => {
      it.each([
        ["missing subject", { body: "b" }],
        ["missing body", { subject: "s" }],
        ["subject present but blank", { subject: "   ", body: "b" }],
        [
          "requesterEmail not an email",
          { subject: "s", body: "b", requesterEmail: "not-an-email" },
        ],
        ["requesterName present but blank", { subject: "s", body: "b", requesterName: "  " }],
      ])("%s", async (_label, partial) => {
        const { app, queue } = buildTestApp(alwaysTrue);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/orgs/bright-smile-dental/requests",
          payload: { ...partial, "cf-turnstile-response": "token" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.headers["content-type"]).toContain("application/problem+json");
        const problem = res.json() as { title: string; detail: string };
        expect(problem.title).toBe("Bad Request");
        expect(problem.detail).toBeTruthy();
        // A rejected request is never enqueued.
        expect(queue.sent).toEqual([]);
      });

      it("does not create a requests row", async () => {
        const { app } = buildTestApp(alwaysTrue);
        const before = await ownerDb.select().from(requests);
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/orgs/bright-smile-dental/requests",
          payload: { body: "b", "cf-turnstile-response": "token" },
        });
        expect(res.statusCode).toBe(400);
        const after = await ownerDb.select().from(requests);
        expect(after).toHaveLength(before.length);
      });
    });
  },
);
