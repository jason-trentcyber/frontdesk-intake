import { randomUUID } from "node:crypto";
import { actions, chunks, createDb, documents, drafts, requests, type Db } from "@frontdesk/db";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { getRequestDetail } from "./requestDetail";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

describe.skipIf(!hasEnv)(
  hasEnv
    ? "getRequestDetail (F11/F12, 26b)"
    : "getRequestDetail (F11/F12, 26b) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let appDb: Db;
    let demoOrgId: string;
    const createdRequestIds: string[] = [];
    const createdDocumentIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      appDb = createDb(appUrl!);
      const orgsResult = await ownerDb.execute<{ id: string; slug: string }>(
        sql`select id, slug from orgs`,
      );
      const demo = orgsResult.rows.find((o) => o.slug === "bright-smile-dental");
      if (!demo)
        throw new Error("expected seed data (bright-smile-dental) - run `pnpm seed` first");
      demoOrgId = demo.id;
    });

    afterEach(async () => {
      while (createdRequestIds.length > 0) {
        const id = createdRequestIds.pop()!;
        await ownerDb.delete(requests).where(eq(requests.id, id));
      }
      while (createdDocumentIds.length > 0) {
        const id = createdDocumentIds.pop()!;
        await ownerDb.delete(documents).where(eq(documents.id, id));
      }
    });

    it("unknown request id -> not_found", async () => {
      const view = await getRequestDetail(appDb, demoOrgId, randomUUID());
      expect(view).toEqual({ kind: "not_found" });
    });

    it("returns the request, its latest draft, resolved citation snippets, and action history newest-first", async () => {
      const [request] = await ownerDb
        .insert(requests)
        .values({
          orgId: demoOrgId,
          source: "form",
          subject: "detail test subject",
          body: "detail test body",
          trackingToken: `detail-test-${randomUUID()}`,
          status: "drafted",
        })
        .returning();
      if (!request) throw new Error("failed to insert test request");
      createdRequestIds.push(request.id);

      const [document] = await ownerDb
        .insert(documents)
        .values({
          orgId: demoOrgId,
          title: "Test policy",
          filename: "test-policy.md",
          mime: "text/markdown",
          sha256: randomUUID(),
          raw: Buffer.from("policy text"),
          status: "indexed",
        })
        .returning();
      if (!document) throw new Error("failed to insert test document");
      createdDocumentIds.push(document.id);

      const secretSnippet = `SNIPPET-${randomUUID()}`;
      const [chunk] = await ownerDb
        .insert(chunks)
        .values({ orgId: demoOrgId, documentId: document.id, ord: 0, text: secretSnippet })
        .returning();
      if (!chunk) throw new Error("failed to insert test chunk");

      // version 1 (superseded) then version 2 (the "latest"/winning one,
      // 26b decision #1) - only version 2's citation should resolve.
      await ownerDb.insert(drafts).values({
        orgId: demoOrgId,
        requestId: request.id,
        version: 1,
        body: "superseded draft body",
        citations: [],
        confidence: "0.500",
        model: "fake",
        promptVersion: "v1",
      });
      await ownerDb.insert(drafts).values({
        orgId: demoOrgId,
        requestId: request.id,
        version: 2,
        body: `latest draft body [c:${chunk.id}]`,
        citations: [chunk.id],
        confidence: "0.750",
        model: "fake",
        promptVersion: "v1",
      });

      await ownerDb.insert(actions).values({
        orgId: demoOrgId,
        requestId: request.id,
        actorEmail: "staff@example.com",
        kind: "edit",
        before: { status: "drafted", replyText: null, draftVersion: 1 },
        after: { status: "drafted", replyText: null, draftVersion: 2 },
        reason: null,
      });

      const view = await getRequestDetail(appDb, demoOrgId, request.id);
      if (view.kind !== "found") throw new Error(`expected found, got ${view.kind}`);

      expect(view.request.subject).toBe("detail test subject");
      expect(view.drafts).toHaveLength(2);
      expect(view.latestDraft?.version).toBe(2);
      expect(view.latestDraft?.body).toContain("latest draft body");

      expect(view.citations).toEqual([{ chunkId: chunk.id, text: secretSnippet }]);

      expect(view.actionHistory).toHaveLength(1);
      expect(view.actionHistory[0]?.kind).toBe("edit");
      expect(view.actionHistory[0]?.actorEmail).toBe("staff@example.com");
    });

    it("a request from another org is not_found, even with the right id (RLS + explicit org_id)", async () => {
      const otherOrg = await ownerDb.execute<{ id: string }>(
        sql`select id from orgs where slug = 'harbor-legal'`,
      );
      const otherOrgId = otherOrg.rows[0]?.id;
      if (!otherOrgId) throw new Error("expected harbor-legal seed org");

      const [request] = await ownerDb
        .insert(requests)
        .values({
          orgId: otherOrgId,
          source: "form",
          subject: "cross-org detail test",
          body: "x",
          trackingToken: `detail-cross-org-${randomUUID()}`,
        })
        .returning();
      if (!request) throw new Error("failed to insert test request");
      createdRequestIds.push(request.id);

      const view = await getRequestDetail(appDb, demoOrgId, request.id);
      expect(view).toEqual({ kind: "not_found" });
    });
  },
);
