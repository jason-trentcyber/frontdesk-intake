"use server";

import { actionKind, actions, drafts, forOrg, requests, type Db } from "@frontdesk/db";
import { and, desc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireMembershipForAction, type AuthenticatedMembership } from "./auth-guard";
import { getDb } from "./db";

type ActionKind = (typeof actionKind.enumValues)[number];

// Every runtime export of a "use server" file must be an async function
// (web/src/lib/submitState.ts's comment, #112's regression) - the
// snapshot type and stringField() below are not exported.

/**
 * F12: "Every action is audit-logged (who, when, before/after)." Nothing
 * in this repo defined that shape before 26b (db/src/seed.ts's own
 * approve-action row only ever recorded {status}) - this is it, identical
 * across approve/edit/reject:
 *
 * - `status`: requests.status before/after this action.
 * - `replyText`: requests.reply_text before/after - null except on the
 *   "after" side of approve/edit, which is the only place a reply is
 *   ever written.
 * - `draftVersion`: the drafts.version this action is based on (approve,
 *   reject) or produces (edit) - null only when no draft exists yet
 *   (reject with nothing drafted). Cross-references drafts without
 *   duplicating its body text into the audit row.
 *
 * "who" is actions.actor_email (the caller's own resolved membership,
 * never client-supplied - see requireMembershipForAction() below);
 * "when" is actions.created_at's default.
 */
interface ActionSnapshot {
  status: string;
  replyText: string | null;
  draftVersion: number | null;
}

function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value.trim() : "";
}

interface CurrentState {
  status: string;
  replyText: string | null;
  latestDraftVersion: number | null;
}

async function loadCurrentState(
  tx: Db,
  orgId: string,
  requestId: string,
): Promise<CurrentState | null> {
  const [current] = await tx
    .select({ status: requests.status, replyText: requests.replyText })
    .from(requests)
    .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));
  if (!current) return null;

  const [latestDraft] = await tx
    .select({ version: drafts.version })
    .from(drafts)
    .where(and(eq(drafts.orgId, orgId), eq(drafts.requestId, requestId)))
    .orderBy(desc(drafts.version))
    .limit(1);

  return {
    status: current.status,
    replyText: current.replyText,
    latestDraftVersion: latestDraft?.version ?? null,
  };
}

async function recordAction(
  tx: Db,
  orgId: string,
  requestId: string,
  membership: AuthenticatedMembership,
  kind: ActionKind,
  before: ActionSnapshot,
  after: ActionSnapshot,
  reason: string | null,
): Promise<void> {
  await tx.insert(actions).values({
    orgId,
    requestId,
    actorEmail: membership.email,
    kind,
    before,
    after,
    reason,
  });
}

function revalidateQueueAndDetail(requestId: string): void {
  revalidatePath("/app");
  revalidatePath(`/app/${requestId}`);
}

// approve/edit/reject are all terminal: each sets resolved_at and a
// terminal status, and /app/[id] hides the action forms once the request
// is in one (RESOLVED_STATUSES there). That UI check is not the control -
// a Server Action is a POST endpoint reachable by a crafted request that
// never rendered the page, which is the same reasoning ADR-0031 §5
// applies to the membership check one line into each action below.
//
// Without this, re-approving an already-rejected request overwrites
// reply_text and publishes a reply on the public /t/<token> page for a
// request staff had declined. The audit trail stays honest either way
// (the second action writes a truthful rejected -> approved row), so
// this is about the request's own state, not about the log.
//
// Checked in the same forOrg() transaction that does the write, against
// the row just read - not against anything the client sent.
const RESOLVED_STATUSES = new Set(["approved", "rejected"]);

function assertNotResolved(status: string): void {
  if (RESOLVED_STATUSES.has(status)) {
    throw new Error(`This request has already been ${status} and cannot be actioned again.`);
  }
}

/**
 * F12 approve: the latest draft's body becomes the reply, verbatim.
 * requireMembershipForAction() is this function's own first statement
 * (ADR-0031 §5) - not passed down from the page, not assumed from the
 * layout having already checked, because a Server Action is reachable by
 * a crafted POST that never rendered the page at all.
 */
export async function approveRequestAction(requestId: string): Promise<void> {
  const membership = await requireMembershipForAction();
  const db = getDb();

  await forOrg(db, membership.orgId, async (tx, orgId) => {
    const state = await loadCurrentState(tx, orgId, requestId);
    if (!state) throw new Error("Request not found.");
    assertNotResolved(state.status);

    const [latestDraft] = await tx
      .select({ version: drafts.version, body: drafts.body })
      .from(drafts)
      .where(and(eq(drafts.orgId, orgId), eq(drafts.requestId, requestId)))
      .orderBy(desc(drafts.version))
      .limit(1);
    if (!latestDraft)
      throw new Error("There is no draft to approve yet - use Edit & Approve to write a reply.");

    const before: ActionSnapshot = {
      status: state.status,
      replyText: state.replyText,
      draftVersion: state.latestDraftVersion,
    };
    const after: ActionSnapshot = {
      status: "approved",
      replyText: latestDraft.body,
      draftVersion: latestDraft.version,
    };

    await tx
      .update(requests)
      .set({ status: "approved", replyText: latestDraft.body, resolvedAt: new Date() })
      .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));

    await recordAction(tx, orgId, requestId, membership, "approve", before, after, null);
  });

  revalidateQueueAndDetail(requestId);
  redirect("/app");
}

/**
 * F12 edit then approve. drafts is append-only (SELECT + INSERT policies
 * only, ADR-0018) - an edit can never UPDATE the draft staff started
 * from, so it INSERTs a new drafts row at version N+1, authored by the
 * staff member (model: "staff", not an LLM's model id - the same
 * sentinel-in-an-existing-column convention db/src/seed.ts already uses
 * for seed-authored drafts via model: "seed"). That new version becomes
 * the "current" draft simply by being the highest version - there is no
 * is_winning column anywhere in this schema, and none is added here;
 * "latest version" already gives an unambiguous answer everywhere this
 * matters (web/src/lib/requestDetail.ts's latestDraft).
 */
export async function editApproveRequestAction(
  requestId: string,
  formData: FormData,
): Promise<void> {
  const membership = await requireMembershipForAction();
  const body = stringField(formData, "body");
  if (!body) throw new Error("Reply text is required.");
  const db = getDb();

  await forOrg(db, membership.orgId, async (tx, orgId) => {
    const state = await loadCurrentState(tx, orgId, requestId);
    if (!state) throw new Error("Request not found.");
    assertNotResolved(state.status);

    const nextVersion = (state.latestDraftVersion ?? 0) + 1;
    await tx.insert(drafts).values({
      orgId,
      requestId,
      version: nextVersion,
      body,
      citations: [],
      // "0" is a sentinel, not a real model score - drafts.confidence is
      // NOT NULL (numeric(4,3), no default), so null isn't an option
      // here without a schema migration this PR doesn't make. model:
      // "staff" is the actual field a reader should key off to tell a
      // staff-authored draft apart from a genuinely low-confidence LLM
      // one (same convention db/src/seed.ts already uses for its own
      // seed-authored drafts) - never read confidence alone.
      confidence: "0",
      model: "staff",
      promptVersion: "n/a",
      tokensIn: 0,
      tokensOut: 0,
    });

    const before: ActionSnapshot = {
      status: state.status,
      replyText: state.replyText,
      draftVersion: state.latestDraftVersion,
    };
    const after: ActionSnapshot = {
      status: "approved",
      replyText: body,
      draftVersion: nextVersion,
    };

    await tx
      .update(requests)
      .set({ status: "approved", replyText: body, resolvedAt: new Date() })
      .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));

    await recordAction(tx, orgId, requestId, membership, "edit", before, after, null);
  });

  revalidateQueueAndDetail(requestId);
  redirect("/app");
}

/** F12 reject with a reason - required, not optional. No reply is written. */
export async function rejectRequestAction(requestId: string, formData: FormData): Promise<void> {
  const membership = await requireMembershipForAction();
  const reason = stringField(formData, "reason");
  if (!reason) throw new Error("A reason is required to reject a request.");
  const db = getDb();

  await forOrg(db, membership.orgId, async (tx, orgId) => {
    const state = await loadCurrentState(tx, orgId, requestId);
    if (!state) throw new Error("Request not found.");
    assertNotResolved(state.status);

    const before: ActionSnapshot = {
      status: state.status,
      replyText: state.replyText,
      draftVersion: state.latestDraftVersion,
    };
    const after: ActionSnapshot = {
      status: "rejected",
      replyText: null,
      draftVersion: state.latestDraftVersion,
    };

    await tx
      .update(requests)
      .set({ status: "rejected", resolvedAt: new Date() })
      .where(and(eq(requests.orgId, orgId), eq(requests.id, requestId)));

    await recordAction(tx, orgId, requestId, membership, "reject", before, after, reason);
  });

  revalidateQueueAndDetail(requestId);
  redirect("/app");
}
