import { documents, forOrg, orgs, type Db } from "@frontdesk/db";
import { and, eq } from "drizzle-orm";
import { assertIngestMessage, type IngestMessage, type Queue } from "./index.js";

/**
 * One-shot enqueue at startup (ADR-0025 §3), beside ensureQueue(): selects
 * every `documents` row still at `status = 'pending'` and enqueues one
 * `frontdesk_ingest` message each. db/src/seed.ts creates ~4 documents per
 * org at `pending`; #24 has no upload route, so this is the only trigger
 * for them.
 *
 * Idempotent in the sense that matters, not by a dedupe check: a document
 * the worker has already indexed is no longer `pending`, so a restart (or
 * running this against an already-ingested database) does not re-enqueue
 * it. A document still mid-flight in the queue from a previous startup
 * *can* be enqueued a second time here - re-ingestion is itself idempotent
 * (ADR-0025 §2: delete-then-insert `chunks` in one transaction), so a
 * duplicate message costs a redundant embed, not a correctness problem.
 *
 * orgs itself is the one unscoped read here (NON_TENANT_TABLES,
 * db/src/client.ts) - only its id is used, to loop; documents is read
 * through forOrg() per org, same reasoning as spend.py's global-ceiling
 * loop on the Python side (frontdesk_app is NOBYPASSRLS, so there is no
 * single unscoped query that spans every org's pending documents).
 */
export async function enqueuePendingIngestMessages(
  db: Db,
  queue: Queue<IngestMessage>,
): Promise<number> {
  const allOrgs = await db.select({ id: orgs.id }).from(orgs);

  let enqueued = 0;
  for (const org of allOrgs) {
    const pending = await forOrg(db, org.id, async (tx, orgId) =>
      tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.orgId, orgId), eq(documents.status, "pending"))),
    );

    for (const doc of pending) {
      const message: IngestMessage = { orgId: org.id, documentId: doc.id };
      // The queue has no RLS (see queue/index.ts): an unscoped message
      // would be accepted silently. Fail here instead, before it is
      // durable - same reasoning as requests.ts's assertTriageMessage call.
      assertIngestMessage(message);
      await queue.send(message);
      enqueued += 1;
    }
  }

  return enqueued;
}
