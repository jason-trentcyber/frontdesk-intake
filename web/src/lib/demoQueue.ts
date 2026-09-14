import { forOrg, orgs, requests, type Db } from "@frontdesk/db";
import { desc, eq } from "drizzle-orm";
import type { NonApprovedStatus } from "./tracking";

export interface DemoOrg {
  id: string;
  slug: string;
  name: string;
}

// F16's landing-page queue is the demo org's, found the same way
// #28's purge job and api/'s index-info route already do: orgs.is_demo,
// never a hardcoded slug (seed data names bright-smile-dental today, but
// that's a fact about the seed, not a contract this code should assume).
// If more than one org is ever marked demo, this shows the first found -
// the landing page has exactly one form/queue pair to show, not a list.
export async function getDemoOrg(db: Db): Promise<DemoOrg | null> {
  const rows = await db
    .select({ id: orgs.id, slug: orgs.slug, name: orgs.name })
    .from(orgs)
    .where(eq(orgs.isDemo, true))
    .limit(1);
  return rows[0] ?? null;
}

export type DemoQueueItem =
  | { kind: "status"; id: string; subject: string; status: NonApprovedStatus }
  // F12/ADR-0027 §2 acceptance: the cited draft shows up here once
  // approved, same "only the approved variant can ever carry a body"
  // shape as web/src/lib/tracking.ts's TrackingView.
  | { kind: "approved"; id: string; subject: string; replyText: string };

const QUEUE_LIMIT = 20;

/**
 * ADR-0007: "Demo org queue is readable without auth via a dedicated
 * read-only endpoint that strips requester contact fields." Stripped at
 * the type, not at render time (27a's TrackingView precedent, and #110's
 * review comment on the same principle): the select below names only
 * id/subject/status/reply_text - requesterName/requesterEmail are never
 * fetched, so no variant of DemoQueueItem has anywhere to put them. A
 * future `{JSON.stringify(item)}` debug dump of this type still couldn't
 * leak them, because they were never in the object to begin with.
 */
export async function getDemoQueue(db: Db, orgId: string): Promise<DemoQueueItem[]> {
  const rows = await forOrg(db, orgId, async (tx, scopedOrgId) => {
    return tx
      .select({
        id: requests.id,
        subject: requests.subject,
        status: requests.status,
        replyText: requests.replyText,
      })
      .from(requests)
      .where(eq(requests.orgId, scopedOrgId))
      .orderBy(desc(requests.createdAt))
      .limit(QUEUE_LIMIT);
  });

  return rows.map((row): DemoQueueItem => {
    if (row.status === "approved") {
      return { kind: "approved", id: row.id, subject: row.subject, replyText: row.replyText ?? "" };
    }
    return { kind: "status", id: row.id, subject: row.subject, status: row.status };
  });
}
