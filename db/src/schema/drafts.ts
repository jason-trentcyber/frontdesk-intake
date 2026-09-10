import { sql } from "drizzle-orm";
import { foreignKey, integer, jsonb, numeric, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
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
