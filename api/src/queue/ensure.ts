import type { Db } from "@frontdesk/db";
import { sql } from "drizzle-orm";
import { QUEUE_NAME } from "./index.js";

/**
 * Creates the triage queue if it does not exist, at startup.
 *
 * Decided in ADR-0022 (docs/adr/0022-queue-provisioning.md), which amends
 * ADR-0004 and ADR-0018. Rationale below is kept because it is the sort of
 * thing a reader hits here first.
 *
 * The brief for #22 said to provision this from a `db/` migration running
 * as the `frontdesk` owner role. That is impossible: `frontdesk` has no
 * privileges at all on schema `pgmq` (`permission denied for schema pgmq`
 * - there is no role-membership path either), and that is deliberate.
 * `deploy/postgres/initdb/002-roles.sh` grants `CREATE ON SCHEMA pgmq` to
 * `frontdesk_app` specifically, and its comment states the intent:
 * pgmq's functions carry no `SECURITY DEFINER`, so `pgmq.create()` runs
 * its internal `CREATE TABLE` as the calling role, and `frontdesk_app`
 * "ends up owning the queue tables it creates - which is exactly the
 * access it needs on them". Queue tables owned by the app role was
 * already the decided design; the brief contradicted it.
 *
 * So provisioning happens here, as `frontdesk_app`, at startup rather
 * than on first send:
 *
 * - `pgmq.create()` is idempotent - a second call emits only NOTICEs
 *   ("relation q_<name> already exists, skipping") and succeeds. Verified
 *   against the pinned image.
 * - Startup, not lazily inside `send()`, so a missing queue fails the
 *   readiness probe rather than surfacing as a 500 on a customer's first
 *   form submission. `pgmq.send()` does NOT auto-create: it fails with
 *   `relation "pgmq.q_frontdesk_triage" does not exist`.
 * - This is the one DDL statement `api/` issues. It creates no tenant
 *   table, so it does not weaken ADR-0018's rule that schema changes are
 *   migrations; queue storage is pgmq's own, outside the Drizzle schema
 *   (ADR-0018: "pgmq's queue tables stay in schema pgmq, outside
 *   Drizzle").
 */
export async function ensureQueue(db: Db, queueName: string = QUEUE_NAME): Promise<void> {
  await db.execute(sql`select pgmq.create(${queueName})`);
}
