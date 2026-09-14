import { fileURLToPath } from "node:url";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { createDb, forOrg, type Db } from "./client.js";
import { logger } from "./logger.js";
import { orgs, requests } from "./schema/index.js";

// #28/F17: nightly demo-org retention. requests is the only table this
// job issues a DELETE against. drafts and actions are append-only from
// the app role's point of view (F12 audit trail, ADR-0018): both tables
// have only org_isolation_select/org_isolation_insert policies, no
// update/delete policy at all. Under RLS, a DELETE with no applicable
// policy does not error - it deletes zero rows and reports success
// (verified locally: `DELETE FROM drafts` as frontdesk_app with
// app.org_id set removed nothing from 6 present rows, no error raised).
// Writing `DELETE FROM drafts`/`actions` directly here would pass CI, run
// nightly, log a cheerful success, and purge nothing.
//
// Both tables' composite FK to requests (org_id, request_id) is
// onDelete("cascade") (db/src/schema/drafts.ts, actions.ts). A
// referential action executes as the FK's owner (frontdesk), not the
// connecting role, so the cascade removes drafts/actions rows even though
// frontdesk_app could never delete them directly - deleting the parent
// request is therefore both correct and the only thing that works.
// purge.test.ts asserts this cascade directly rather than trusting this
// comment: if a future migration drops onDelete("cascade"), that test
// starts failing instead of the purge silently leaving orphans.

// A single unbounded DELETE would hold its lock for however long the
// whole demo org's overdue backlog takes - on a 4 GB single-node Postgres
// that also serves live triage traffic (ADR-0010), that is a real
// contention risk once a public form (27b) has been feeding this org for
// a while, even though it's six seeded rows today. Batching by id keeps
// each transaction, and therefore each lock, short and bounded regardless
// of backlog size.
const DEFAULT_BATCH_SIZE = 500;

export interface PurgeOrgResult {
  orgId: string;
  orgSlug: string;
  deletedCount: number;
}

export interface PurgeOptions {
  /** Requests with created_at older than this are deleted. */
  cutoff: Date;
  batchSize?: number;
}

/**
 * F17: purges every demo org's (`orgs.is_demo`) requests older than
 * `cutoff`, cascading to their drafts/actions. Never touches a non-demo
 * org, and never touches `documents`/`chunks` - those are the demo org's
 * seeded knowledge base, not per-visitor data, and have no 24h lifetime
 * (#28 is "requests/drafts/actions", not the RAG corpus).
 *
 * `orgs` carries no org_id/RLS (it isn't a tenant table - db/src/schema/
 * orgs.ts); reading `is_demo` off it directly, the same way
 * api/src/routes/index-info.ts does, is the intended unscoped read.
 * Zero or several demo orgs are both handled by iterating the result set
 * rather than assuming exactly one row.
 */
export async function purgeDemoOrgs(db: Db, options: PurgeOptions): Promise<PurgeOrgResult[]> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const demoOrgs = await db.select({ id: orgs.id, slug: orgs.slug }).from(orgs).where(eq(orgs.isDemo, true));

  const results: PurgeOrgResult[] = [];
  for (const org of demoOrgs) {
    const deletedCount = await purgeOrgRequests(db, org.id, options.cutoff, batchSize);
    results.push({ orgId: org.id, orgSlug: org.slug, deletedCount });
  }
  return results;
}

async function purgeOrgRequests(db: Db, orgId: string, cutoff: Date, batchSize: number): Promise<number> {
  let total = 0;
  for (;;) {
    const deletedIds = await forOrg(db, orgId, async (tx, scopedOrgId) => {
      // AGENTS.md: "Every query on a tenant table includes org_id. No
      // exceptions" - RLS (via forOrg's set_config) already scopes both
      // statements below to this org, but org_id is still explicit in
      // both WHERE clauses (ADR-0018 "belt and braces").
      const stale = await tx
        .select({ id: requests.id })
        .from(requests)
        .where(and(eq(requests.orgId, scopedOrgId), lt(requests.createdAt, cutoff)))
        .orderBy(asc(requests.createdAt))
        .limit(batchSize);
      if (stale.length === 0) return [];

      const ids = stale.map((r) => r.id);
      await tx.delete(requests).where(and(eq(requests.orgId, scopedOrgId), inArray(requests.id, ids)));
      return ids;
    });

    total += deletedIds.length;
    // A short batch means this was the last one - no need for a trailing
    // empty-batch round trip to confirm it.
    if (deletedIds.length < batchSize) break;
  }
  return total;
}

function retentionHours(): number {
  const raw = process.env.DEMO_PURGE_RETENTION_HOURS;
  if (raw === undefined) return 24;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`DEMO_PURGE_RETENTION_HOURS must be a positive number, got: ${raw}`);
  }
  return parsed;
}

// Only run as a CLI entrypoint (the CronJob's command), not when
// purge.test.ts imports purgeDemoOrgs directly - same guard as seed.ts.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // frontdesk_app, not frontdesk: this job only ever needs SELECT on
  // orgs (already granted) and row-scoped DML on requests (granted by
  // its own "org_isolation" ALL policy) - no schema privilege the owner
  // role has and the runtime role doesn't. Same ADR-0017 audience as
  // web/api/worker, never frontdesk-password. DATABASE_APP_URL is the
  // local-dev name for that role; production sets only DATABASE_URL
  // (same fallback api/src/env.ts uses).
  const url = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL (or DATABASE_APP_URL locally) is required");
  }

  const hours = retentionHours();
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);
  const db = createDb(url);

  purgeDemoOrgs(db, { cutoff })
    .then((results) => {
      if (results.length === 0) {
        logger.info("demo purge: no demo org configured, nothing to do", {});
        return;
      }
      for (const result of results) {
        logger.info("demo purge: deleted requests", { ...result });
      }
      logger.info("demo purge complete", {
        orgCount: results.length,
        deletedCount: results.reduce((sum, r) => sum + r.deletedCount, 0),
        retentionHours: hours,
        cutoff: cutoff.toISOString(),
      });
    })
    .catch((err: unknown) => {
      logger.error("demo purge failed", { error: err instanceof Error ? err.message : String(err) });
      process.exitCode = 1;
    });
}
