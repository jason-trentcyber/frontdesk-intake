import { randomUUID } from "node:crypto";
import { actions, createDb, drafts, requests, type Db } from "@frontdesk/db";
import { and, eq, sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

// requireMembershipForAction() needs a real Next request (cookies) to
// resolve a session - unavailable outside a real server, so it's mocked
// here the same way web/src/lib/auth-guard.test.ts mocks ./auth: a fixed
// membership pointing at the real seeded demo org, so everything these
// actions actually do (the forOrg() transaction, the requests/drafts/
// actions writes) runs for real against Postgres. revalidatePath() and
// redirect() both throw "no request context" errors outside a real Next
// server (verified locally, not assumed) - by the time either runs, the
// DB transaction has already committed, so `.rejects.toBeTruthy()` plus
// a follow-up read through the owner connection is what every test below
// asserts on.
let mockOrgId = "";
const mockEmail = "staff-actions-test@example.com";
vi.mock("./auth-guard", () => ({
  requireMembershipForAction: () =>
    Promise.resolve({ orgId: mockOrgId, role: "staff", email: mockEmail }),
}));

const { approveRequestAction, editApproveRequestAction, rejectRequestAction } =
  await import("./staffActions");

describe.skipIf(!hasEnv)(
  hasEnv
    ? "staff actions (F12, 26b)"
    : "staff actions (F12, 26b) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    const createdRequestIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      const orgsResult = await ownerDb.execute<{ id: string }>(
        sql`select id from orgs where slug = 'bright-smile-dental'`,
      );
      const demoOrgId = orgsResult.rows[0]?.id;
      if (!demoOrgId)
        throw new Error("expected seed data (bright-smile-dental) - run `pnpm seed` first");
      mockOrgId = demoOrgId;
    });

    afterEach(async () => {
      while (createdRequestIds.length > 0) {
        const id = createdRequestIds.pop()!;
        await ownerDb.delete(requests).where(eq(requests.id, id));
      }
    });

    async function makeRequest(): Promise<string> {
      const [row] = await ownerDb
        .insert(requests)
        .values({
          orgId: mockOrgId,
          source: "form",
          subject: "staff action test subject",
          body: "staff action test body",
          trackingToken: `staff-action-${randomUUID()}`,
          status: "drafted",
        })
        .returning({ id: requests.id });
      if (!row) throw new Error("failed to insert test request");
      createdRequestIds.push(row.id);
      return row.id;
    }

    it("approve: writes the latest draft's body to reply_text, sets status=approved, records an audit row", async () => {
      const requestId = await makeRequest();
      await ownerDb.insert(drafts).values({
        orgId: mockOrgId,
        requestId,
        version: 1,
        body: "the drafted reply",
        citations: [],
        confidence: "0.900",
        model: "fake",
        promptVersion: "v1",
      });

      await expect(approveRequestAction(requestId)).rejects.toBeTruthy();

      const [row] = await ownerDb.select().from(requests).where(eq(requests.id, requestId));
      expect(row?.status).toBe("approved");
      expect(row?.replyText).toBe("the drafted reply");
      expect(row?.resolvedAt).not.toBeNull();

      const [action] = await ownerDb
        .select()
        .from(actions)
        .where(and(eq(actions.requestId, requestId), eq(actions.kind, "approve")));
      expect(action?.actorEmail).toBe(mockEmail);
      expect(action?.before).toEqual({ status: "drafted", replyText: null, draftVersion: 1 });
      expect(action?.after).toEqual({
        status: "approved",
        replyText: "the drafted reply",
        draftVersion: 1,
      });
      expect(action?.reason).toBeNull();
    });

    it("approve: throws (and writes nothing) when there is no draft to approve", async () => {
      const requestId = await makeRequest();

      await expect(approveRequestAction(requestId)).rejects.toThrow(/no draft to approve/i);

      const [row] = await ownerDb.select().from(requests).where(eq(requests.id, requestId));
      expect(row?.status).toBe("drafted"); // unchanged
    });

    it("edit & approve: inserts a new draft at version N+1 (append-only - never updates the old one) and writes its body to reply_text", async () => {
      const requestId = await makeRequest();
      await ownerDb.insert(drafts).values({
        orgId: mockOrgId,
        requestId,
        version: 1,
        body: "original ai draft",
        citations: [],
        confidence: "0.900",
        model: "fake",
        promptVersion: "v1",
      });

      const formData = new FormData();
      formData.set("body", "the staff-edited reply");
      await expect(editApproveRequestAction(requestId, formData)).rejects.toBeTruthy();

      const draftRows = await ownerDb.select().from(drafts).where(eq(drafts.requestId, requestId));
      expect(draftRows).toHaveLength(2);
      const v1 = draftRows.find((d) => d.version === 1);
      const v2 = draftRows.find((d) => d.version === 2);
      expect(v1?.body).toBe("original ai draft"); // untouched - append-only
      expect(v2?.body).toBe("the staff-edited reply");
      expect(v2?.model).toBe("staff");

      const [row] = await ownerDb.select().from(requests).where(eq(requests.id, requestId));
      expect(row?.status).toBe("approved");
      expect(row?.replyText).toBe("the staff-edited reply");

      const [action] = await ownerDb
        .select()
        .from(actions)
        .where(and(eq(actions.requestId, requestId), eq(actions.kind, "edit")));
      expect(action?.after).toEqual({
        status: "approved",
        replyText: "the staff-edited reply",
        draftVersion: 2,
      });
    });

    it("edit & approve: works from scratch with no prior draft at all (version 1)", async () => {
      const requestId = await makeRequest();

      const formData = new FormData();
      formData.set("body", "written entirely by staff, no draft existed");
      await expect(editApproveRequestAction(requestId, formData)).rejects.toBeTruthy();

      const draftRows = await ownerDb.select().from(drafts).where(eq(drafts.requestId, requestId));
      expect(draftRows).toHaveLength(1);
      expect(draftRows[0]?.version).toBe(1);
      expect(draftRows[0]?.model).toBe("staff");
    });

    it("edit & approve: rejects an empty reply", async () => {
      const requestId = await makeRequest();
      const formData = new FormData();
      formData.set("body", "   ");
      await expect(editApproveRequestAction(requestId, formData)).rejects.toThrow(/required/i);

      const [row] = await ownerDb.select().from(requests).where(eq(requests.id, requestId));
      expect(row?.status).toBe("drafted"); // unchanged
    });

    it("reject: requires a reason, writes no reply, records the reason on the audit row", async () => {
      const requestId = await makeRequest();

      const emptyReason = new FormData();
      await expect(rejectRequestAction(requestId, emptyReason)).rejects.toThrow(
        /reason is required/i,
      );

      const reasonForm = new FormData();
      reasonForm.set("reason", "duplicate of an earlier request");
      await expect(rejectRequestAction(requestId, reasonForm)).rejects.toBeTruthy();

      const [row] = await ownerDb.select().from(requests).where(eq(requests.id, requestId));
      expect(row?.status).toBe("rejected");
      expect(row?.replyText).toBeNull();

      const [action] = await ownerDb
        .select()
        .from(actions)
        .where(and(eq(actions.requestId, requestId), eq(actions.kind, "reject")));
      expect(action?.reason).toBe("duplicate of an earlier request");
      expect(action?.after).toEqual({ status: "rejected", replyText: null, draftVersion: null });
    });

    // /app/[id] hides the action forms once a request is approved or
    // rejected, but a Server Action is a POST endpoint reachable without
    // ever rendering that page - the same reasoning ADR-0031 §5 applies
    // to the membership check. Without the guard, re-approving a
    // rejected request publishes a reply on the public /t/<token> page
    // for a request staff had declined.
    describe("a resolved request cannot be actioned again", () => {
      async function rejectedRequest(): Promise<string> {
        const requestId = await makeRequest();
        const form = new FormData();
        form.set("reason", "declined");
        await expect(rejectRequestAction(requestId, form)).rejects.toBeTruthy();
        return requestId;
      }

      it("approve: refuses, leaving the rejection and its reply_text intact", async () => {
        const requestId = await rejectedRequest();
        await ownerDb.insert(drafts).values({
          orgId: mockOrgId,
          requestId,
          version: 1,
          body: "a reply that must never be published",
          citations: [],
          confidence: "0.900",
          model: "fake",
          promptVersion: "v1",
        });

        await expect(approveRequestAction(requestId)).rejects.toThrow(/already been rejected/i);

        const [row] = await ownerDb.select().from(requests).where(eq(requests.id, requestId));
        expect(row?.status).toBe("rejected");
        expect(row?.replyText).toBeNull();
      });

      it("edit & approve: refuses, and writes no new draft version", async () => {
        const requestId = await rejectedRequest();

        const form = new FormData();
        form.set("body", "a reply that must never be published");
        await expect(editApproveRequestAction(requestId, form)).rejects.toThrow(
          /already been rejected/i,
        );

        const [row] = await ownerDb.select().from(requests).where(eq(requests.id, requestId));
        expect(row?.status).toBe("rejected");
        expect(row?.replyText).toBeNull();

        const draftRows = await ownerDb
          .select()
          .from(drafts)
          .where(eq(drafts.requestId, requestId));
        expect(draftRows).toHaveLength(0);
      });

      it("reject: refuses to re-reject, leaving the original audit row the only one", async () => {
        const requestId = await rejectedRequest();

        const form = new FormData();
        form.set("reason", "a second, different reason");
        await expect(rejectRequestAction(requestId, form)).rejects.toThrow(
          /already been rejected/i,
        );

        const actionRows = await ownerDb
          .select()
          .from(actions)
          .where(and(eq(actions.requestId, requestId), eq(actions.kind, "reject")));
        expect(actionRows).toHaveLength(1);
        expect(actionRows[0]?.reason).toBe("declined");
      });
    });
  },
);
