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
    // 50k synthetic rows (this table had 8 at 26b-design time, so nothing
    // here is measurable yet): a sequential scan cost ~20-33ms and read
    // every row in the table regardless of org (RLS's org_id compare is a
    // row-by-row filter, not an index lookup, without this); this index
    // dropped both the filtered and unfiltered query to ~0.25ms via an
    // index scan that stops at the LIMIT. See the 26b PR body for the
    // full EXPLAIN ANALYZE output both ways.
    index("requests_org_id_created_at_idx").on(t.orgId, t.createdAt.desc()),
    pgPolicy("org_isolation", {
      for: "all",
      to: "frontdesk_app",
      using: sql`org_id = current_org_id()`,
      withCheck: sql`org_id = current_org_id()`,
    }),
  ],
).enableRLS();
