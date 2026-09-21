import { forOrg, orgs, orgSettingsSchema, requestStatus, requests, type Db } from "@frontdesk/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";

export type RequestStatus = (typeof requestStatus.enumValues)[number];

export interface StaffQueueItem {
  id: string;
  subject: string;
  status: RequestStatus;
  urgency: string | null;
  lane: string | null;
  createdAt: Date;
}

export interface StaffQueueFilters {
  status?: RequestStatus[];
  lane?: string[];
  category?: string[];
}

const QUEUE_LIMIT = 50;

/**
 * Sort key for the staff queue (#153): the rows a person must look at
 * first come first, and only then does age order the rest.
 *
 *   0  needs_human    - the pipeline could not produce a draft
 *   1  high urgency   - a draft exists, but nothing about it should be
 *                       one-click approved without reading (a "do I
 *                       need to be seen today?" question, per the
 *                       urgency rubric in worker/prompts/classify.md)
 *   2  everything else
 *
 * Deliberately NOT a status change in the pipeline: request status is
 * what /t/[token] renders to the requester, and drafted / needs_human
 * both collapse to "In review" there (lib/tracking.ts). Nothing reaches
 * a requester until a human approves (F12), so a high-urgency request
 * was never at risk of being auto-answered; the risk was that it sat
 * under newer, lower-stakes rows in a created_at-ordered queue. This
 * fixes the queue, not the state machine. docs/adr/0037 has the
 * reasoning.
 *
 * Resolved rows (approved/rejected) rank 2 regardless of urgency - a
 * resolved high-urgency request has nothing left for staff to do and
 * should not keep floating above live work when the status filter
 * includes it.
 */
const TRIAGE_RANK = sql<number>`case
  when ${requests.status} in ('approved', 'rejected') then 2
  when ${requests.status} = 'needs_human' then 0
  when ${requests.urgency} = 'high' then 1
  else 2
end`;

/**
 * F10: queue view per org (lane, urgency, age, status columns), filtered
 * by status/lane/category. Goes through forOrg() like every other tenant
 * read (ADR-0018/0021); the caller supplies orgId from a fresh
 * requireSessionOrRedirect()/requireMembershipForAction() call, never a
 * cached value (ADR-0031 §3).
 *
 * `WHERE org_id = $1 [AND status/lane/category] ORDER BY <triage rank>,
 * created_at DESC LIMIT 50`. requests_org_id_created_at_idx
 * (db/src/schema/requests.ts) still serves the org_id filter; the rank
 * expression means Postgres sorts the org's matching rows in memory
 * rather than walking the index straight into LIMIT. At this table's
 * size that is a top-N heapsort over a few hundred rows per org - fine.
 * If an org ever has enough rows for that sort to show up in EXPLAIN,
 * the fix is an expression index on (org_id, <rank>, created_at desc),
 * not a return to age-only ordering.
 */
export async function getStaffQueue(
  db: Db,
  orgId: string,
  filters: StaffQueueFilters = {},
): Promise<StaffQueueItem[]> {
  return forOrg(db, orgId, async (tx, scopedOrgId) => {
    const conditions = [eq(requests.orgId, scopedOrgId)];
    if (filters.status && filters.status.length > 0) {
      conditions.push(inArray(requests.status, filters.status));
    }
    if (filters.lane && filters.lane.length > 0) {
      conditions.push(inArray(requests.lane, filters.lane));
    }
    if (filters.category && filters.category.length > 0) {
      conditions.push(inArray(requests.category, filters.category));
    }

    return tx
      .select({
        id: requests.id,
        subject: requests.subject,
        status: requests.status,
        urgency: requests.urgency,
        lane: requests.lane,
        createdAt: requests.createdAt,
      })
      .from(requests)
      .where(and(...conditions))
      .orderBy(TRIAGE_RANK, desc(requests.createdAt))
      .limit(QUEUE_LIMIT);
  });
}

export interface StaffQueueFilterOptions {
  statuses: RequestStatus[];
  lanes: string[];
  categories: string[];
}

/**
 * F10's filter values come from the org's own configurable settings
 * (orgs.settings.categories / .lanes - db/src/settings.ts), never a
 * hardcoded array: two orgs can and do use different category/lane
 * vocabularies (db/src/seed.ts's bright-smile-dental vs harbor-legal).
 * `orgs` carries no org_id/RLS (it is the NON_TENANT_TABLES exception,
 * ADR-0018) - read directly, filtered by id, same as demoQueue.ts's
 * getDemoOrg().
 */
export async function getStaffQueueFilterOptions(
  db: Db,
  orgId: string,
): Promise<StaffQueueFilterOptions> {
  const [row] = await db.select({ settings: orgs.settings }).from(orgs).where(eq(orgs.id, orgId));
  const settings = orgSettingsSchema.parse(row?.settings ?? {});
  const lanes = Array.from(new Set(Object.values(settings.lanes))).sort();
  return {
    // Unlike lanes/categories, statuses is the full fixed enum, not
    // derived from what's currently in the queue: a status filter
    // checkbox that only appears once a row with that status exists
    // would be confusing (staff couldn't pre-filter to "show me
    // approved" on a queue that happens to have zero right now).
    statuses: requestStatus.enumValues,
    lanes,
    categories: settings.categories,
  };
}
