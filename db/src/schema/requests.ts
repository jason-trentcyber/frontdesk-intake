import { sql } from "drizzle-orm";
import { index, pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { requestSource, requestStatus, requestUrgency } from "./enums.js";
import { orgs } from "./orgs.js";

export const requests = pgTable(
  "requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    source: requestSource("source").notNull(),
    // F1: name and email are both optional on the public form.
    requesterName: text("requester_name"),
    requesterEmail: text("requester_email"),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    // F2: the tracking-page token, /t/<token>.
    trackingToken: text("tracking_token").notNull().unique(),
    status: requestStatus("status").notNull().default("received"),
    // Free text, not an enum: both come from the org's own configurable
    // settings.categories / settings.lanes map (db/src/settings.ts), set
    // by the triage pipeline (F4) - null until then.
    category: text("category"),
    urgency: requestUrgency("urgency"),
    summary: text("summary"),
    lane: text("lane"),
    // Snapshot of the approved reply, written at approve time (F12); the
    // live value lives on the winning draft until then.
    replyText: text("reply_text"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Referenced compositely by drafts and actions (org_id, request_id) ->
    // (org_id, id); a composite FK needs an exact-matching unique
    // constraint on the referenced columns, which the id-only PK doesn't
    // satisfy by itself.
    unique("requests_org_id_id_unique").on(t.orgId, t.id),
    // 26b's staff queue (F10: filter by lane/status, sorted by age) reads
    // this table as `WHERE org_id = $1 [AND status/lane filters] ORDER BY
    // created_at DESC LIMIT 50` on every /app page load. Measured against
    // 50k synthetic rows loaded into a local Postgres for this check only
    // (this table had 8 real rows at 26b-design time, so nothing here was
    // measurable without them - inserted and deleted in the same session,
    // never committed), as frontdesk_app with RLS active, EXPLAIN
    // (ANALYZE, BUFFERS), no filter + LIMIT 50:
    //
    //   Without this index:
    //     Seq Scan on requests (actual time=0.008..10.299 rows=50008)
    //       Filter: (org_id = $1)
    //       Buffers: shared hit=1060
    //     Execution Time: 32.635 ms
    //   With it:
    //     Index Scan using requests_org_id_created_at_idx (actual time=0.114..0.134 rows=50)
    //       Index Cond: (org_id = $1)
    //       Buffers: shared hit=2 read=3
    //     Execution Time: 0.261 ms
    //
    // ~125x, and the buffer-read count (1060 -> 5) is the more durable
    // number - it doesn't depend on what else happens to be cached. A
    // `status IN (...)` filter shows the same shape (19.6ms seq scan,
    // discarding 33,339 non-matching rows, vs 0.25ms index scan
    // discarding only 97 before hitting LIMIT 50, since the index already
    // walks in created_at order). Crucially, the seq-scan cost is driven
    // by the table's TOTAL row count across every org, not the querying
    // org's own count - a quiet org sharing this table with a busy one
    // pays the busy one's scan cost on every /app load without this.
    //
    // Plain CREATE INDEX, not CONCURRENTLY: this table has a handful of
    // rows in production today, so the brief ACCESS EXCLUSIVE lock a
    // plain build takes is real but immaterial, and the
    // frontdesk-db-migrate hook Job (ADR-0018/0019) already runs every
    // migration inside Drizzle's own transaction, which CONCURRENTLY
    // cannot run inside. Revisit if this table ever needs an index added
    // once it holds enough rows for that lock to be felt - by then the
    // migrate Job's transactional-migration assumption needs revisiting
    // too, not just this one statement.
    index("requests_org_id_created_at_idx").on(t.orgId, t.createdAt.desc()),
    pgPolicy("org_isolation", {
      for: "all",
      to: "frontdesk_app",
      using: sql`org_id = current_org_id()`,
      withCheck: sql`org_id = current_org_id()`,
    }),
  ],
).enableRLS();
