import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
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
    pgPolicy("org_isolation", {
      for: "all",
      to: "frontdesk_app",
      using: sql`org_id = current_org_id()`,
      withCheck: sql`org_id = current_org_id()`,
    }),
  ],
).enableRLS();
