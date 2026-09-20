import { sql } from "drizzle-orm";
import {
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { requests } from "./requests.js";

// Append-only from the app role's point of view (F12 audit trail): select
// + insert policies only, no update/delete (ADR-0018).
export const drafts = pgTable(
  "drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    requestId: uuid("request_id").notNull(),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    // [c:<id>] citation ids the draft prompt relied on (ADR-0005).
    citations: jsonb("citations").notNull().default([]),
    confidence: numeric("confidence", { precision: 4, scale: 3 }).notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    tokensIn: integer("tokens_in").notNull().default(0),
    tokensOut: integer("tokens_out").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.requestId],
      foreignColumns: [requests.orgId, requests.id],
    }).onDelete("cascade"),
    // Both writers of this table compute the next version by reading the
    // current maximum and adding one: the worker's triage pipeline
    // (worker/frontdesk_worker/pipeline.py, _next_draft_version) and
    // 26b's edit-then-approve (web/src/lib/staffActions.ts). A
    // read-then-insert is not atomic across concurrent transactions, so
    // without this constraint two of them can both observe version N and
    // both insert N+1 - which Postgres accepts.
    //
    // That matters because "the latest version is the current draft" is
    // the invariant 26b's detail page and edit flow are built on
    // (web/src/lib/requestDetail.ts) - there is deliberately no
    // is_winning column. With two rows at the same version, `order by
    // version desc limit 1` picks one arbitrarily while
    // requests.reply_text holds whichever transaction committed last, so
    // the page and the published reply can silently disagree. RLS does
    // not catch it: both rows are correctly org-scoped.
    //
    // A unique constraint turns that into a failed insert instead. Both
    // call sites already handle a failed write correctly - the worker
    // leaves the request at 'triaging' and re-triages on redelivery
    // (pipeline.py's module docstring), and the Server Action's
    // forOrg() transaction rolls back with nothing written.
    unique("drafts_org_id_request_id_version_unique").on(t.orgId, t.requestId, t.version),
    pgPolicy("org_isolation_select", {
      for: "select",
      to: "frontdesk_app",
      using: sql`org_id = current_org_id()`,
    }),
    pgPolicy("org_isolation_insert", {
      for: "insert",
      to: "frontdesk_app",
      withCheck: sql`org_id = current_org_id()`,
    }),
  ],
).enableRLS();
