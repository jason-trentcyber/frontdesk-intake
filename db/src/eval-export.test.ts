import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";
import { exportCandidates, toJsonl } from "./eval-export.js";
import { actions, drafts, orgs, requests } from "./schema/index.js";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

// Same skip pattern as purge.test.ts / rls.test.ts: named skip without
// Postgres so `pnpm test` at the root stays green; CI sets both URLs.
describe.skipIf(!hasEnv)(
  hasEnv
    ? "eval export (#31, F13)"
    : "eval export (#31, F13) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let appDb: Db;
    let orgId: string;
    let otherOrgId: string;
    const createdOrgIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      // The CLI runs as frontdesk_app (ADR-0017); prove the export works
      // under RLS, not only for a connection that bypasses it.
      appDb = createDb(appUrl!);
      for (const name of ["eval-export-a", "eval-export-b"]) {
        const [org] = await ownerDb
          .insert(orgs)
          .values({ slug: `${name}-${randomUUID().slice(0, 8)}`, name, settings: {} })
          .returning({ id: orgs.id });
        if (!org) throw new Error("failed to insert test org");
        createdOrgIds.push(org.id);
      }
      [orgId, otherOrgId] = createdOrgIds as [string, string];
    });

    afterAll(async () => {
      // requests cascade to actions
      await ownerDb.delete(requests).where(inArray(requests.orgId, createdOrgIds));
      await ownerDb.delete(orgs).where(inArray(orgs.id, createdOrgIds));
    });

    async function makeRequest(org: string, subject: string, category: string) {
      const [row] = await ownerDb
        .insert(requests)
        .values({
          orgId: org,
          source: "form",
          subject,
          body: `${subject} - body`,
          trackingToken: `t-${randomUUID()}`,
          category,
          urgency: "normal",
          status: "drafted",
        })
        .returning({ id: requests.id });
      if (!row) throw new Error("failed to insert test request");
      return row.id;
    }

    // Mirrors what web/src/lib/staffActions.ts actually writes: the model
    // draft lives in `drafts` at `before.draftVersion`; `before.replyText`
    // is the request's reply (null until approved), not the draft body.
    async function makeAction(
      org: string,
      requestId: string,
      kind: "approve" | "edit" | "reject",
      fields: { draft?: string; after?: string | null; reason?: string | null } = {},
    ) {
      await ownerDb.insert(drafts).values({
        orgId: org,
        requestId,
        version: 1,
        body: fields.draft ?? "model draft",
        citations: [],
        confidence: "0.900",
        model: "fake",
        promptVersion: "v1",
      });
      await ownerDb.insert(actions).values({
        orgId: org,
        requestId,
        actorEmail: "staff@example.test",
        kind,
        before: { status: "drafted", replyText: null, draftVersion: 1 },
        after: {
          status: kind === "reject" ? "rejected" : "approved",
          replyText: fields.after ?? null,
          draftVersion: kind === "edit" ? 2 : 1,
        },
        reason: fields.reason ?? null,
      });
    }

    it("exports one candidate per edit/reject, skips approvals, and never crosses orgs", async () => {
      const edited = await makeRequest(orgId, "Do you take Delta Dental?", "insurance");
      const rejected = await makeRequest(orgId, "Buy my SEO package", "other");
      const approved = await makeRequest(orgId, "Hours on Friday?", "scheduling");
      const foreign = await makeRequest(otherOrgId, "Other org's edit", "billing");

      await makeAction(orgId, edited, "edit", { draft: "model draft", after: "human text" });
      await makeAction(orgId, rejected, "reject", { draft: "model draft", reason: "spam" });
      await makeAction(orgId, approved, "approve", { draft: "model draft", after: "model draft" });
      await makeAction(otherOrgId, foreign, "edit", { draft: "x", after: "y" });

      const examples = await exportCandidates(appDb, orgId);

      expect(examples.map((e) => e.subject).sort()).toEqual([
        "Buy my SEO package",
        "Do you take Delta Dental?",
      ]);

      const edit = examples.find((e) => e.provenance.action === "edit")!;
      expect(edit.expected_category).toBe("insurance");
      expect(edit.expected_urgency).toBe("normal");
      expect(edit.expected_chunk).toBeNull();
      expect(edit.provenance.model_reply).toBe("model draft");
      expect(edit.provenance.human_reply).toBe("human text");
      expect(edit.provenance.reason).toBeNull();
      expect(edit.provenance.actor).toBe("staff@example.test");
      expect(edit.id).toMatch(/^candidate-[0-9a-f-]{36}$/);

      const reject = examples.find((e) => e.provenance.action === "reject")!;
      expect(reject.provenance.reason).toBe("spam");
      expect(reject.provenance.human_reply).toBeNull();

      // The other org's edit is invisible from this org (RLS + explicit org_id).
      expect(examples.some((e) => e.subject === "Other org's edit")).toBe(false);
      expect((await exportCandidates(appDb, otherOrgId)).map((e) => e.subject)).toEqual([
        "Other org's edit",
      ]);
    });

    it("writes golden-shaped JSONL lines with the provenance block", async () => {
      const examples = await exportCandidates(appDb, orgId);
      const lines = toJsonl(examples).trimEnd().split("\n");
      expect(lines).toHaveLength(examples.length);
      for (const line of lines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(Object.keys(parsed).sort()).toEqual([
          "body",
          "expected_category",
          "expected_chunk",
          "expected_urgency",
          "id",
          "provenance",
          "subject",
        ]);
      }
    });

    it("returns an empty list for an org with no edits or rejects", async () => {
      const [empty] = await ownerDb
        .insert(orgs)
        .values({
          slug: `eval-export-empty-${randomUUID().slice(0, 8)}`,
          name: "empty",
          settings: {},
        })
        .returning({ id: orgs.id });
      createdOrgIds.push(empty!.id);
      expect(await exportCandidates(appDb, empty!.id)).toEqual([]);
      expect(toJsonl([])).toBe("");
      await ownerDb.delete(orgs).where(eq(orgs.id, empty!.id));
    });
  },
);
