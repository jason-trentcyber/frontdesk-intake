import { sql } from "drizzle-orm";
import { foreignKey, jsonb, pgPolicy, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { actionKind } from "./enums.js";
import { requests } from "./requests.js";

// Append-only from the app role's point of view (F12 audit trail): select
// + insert policies only, no update/delete (ADR-0018).
export const actions = pgTable(
  "actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    requestId: uuid("request_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    kind: actionKind("kind").notNull(),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
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
