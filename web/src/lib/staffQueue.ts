import { forOrg, orgs, orgSettingsSchema, requestStatus, requests, type Db } from "@frontdesk/db";
import { and, desc, eq, inArray } from "drizzle-orm";

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
 * F10: queue view per org (lane, urgency, age, status columns), filtered
 * by status/lane/category. Goes through forOrg() like every other tenant
 * read (ADR-0018/0021); the caller supplies orgId from a fresh
 * requireSessionOrRedirect()/requireMembershipForAction() call, never a
 * cached value (ADR-0031 §3).
 *
 * `WHERE org_id = $1 [AND status/lane/category] ORDER BY created_at DESC
 * LIMIT 50` is backed by requests_org_id_created_at_idx
 * (db/src/schema/requests.ts) - see that file's comment and the 26b PR
 * body for the EXPLAIN ANALYZE evidence at 50k synthetic rows.
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
      .orderBy(desc(requests.createdAt))
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
