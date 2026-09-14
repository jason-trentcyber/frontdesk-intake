import { forOrg, requests, type Db } from "@frontdesk/db";
import { desc, eq } from "drizzle-orm";

export interface StaffQueueItem {
  id: string;
  subject: string;
  status: string;
  urgency: string | null;
  createdAt: Date;
}

const QUEUE_LIMIT = 50;

/**
 * 26a's minimal staff queue (F10 lands its full lane/urgency/age/status
 * filters in 26b) - just enough of a real, org-scoped read to prove the
 * property #26 is actually asked to prove: an org's session sees only
 * its own org's requests. Goes through forOrg() like every other
 * tenant read (ADR-0018/0021); the caller supplies orgId from a fresh
 * requireSessionOrRedirect()/requireMembershipForAction() call, never
 * from a cached value (ADR-0031 §3).
 */
export async function getStaffQueue(db: Db, orgId: string): Promise<StaffQueueItem[]> {
  return forOrg(db, orgId, async (tx, scopedOrgId) => {
    return tx
      .select({
        id: requests.id,
        subject: requests.subject,
        status: requests.status,
        urgency: requests.urgency,
        createdAt: requests.createdAt,
      })
      .from(requests)
      .where(eq(requests.orgId, scopedOrgId))
      .orderBy(desc(requests.createdAt))
      .limit(QUEUE_LIMIT);
  });
}
