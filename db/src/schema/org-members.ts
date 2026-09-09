import { sql } from "drizzle-orm";
import { pgPolicy, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { citext } from "./custom-types.js";
import { memberRole } from "./enums.js";
import { orgs } from "./orgs.js";

export const orgMembers = pgTable(
  "org_members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    // Globally unique, not per-org (ADR-0018): a staff member belongs to
    // exactly one org, so sign-in resolves to one row or none.
    email: citext("email").notNull().unique(),
    role: memberRole("role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [
    pgPolicy("org_isolation", {
      for: "all",
      to: "frontdesk_app",
      using: sql`org_id = current_org_id()`,
      withCheck: sql`org_id = current_org_id()`,
    }),
  ],
).enableRLS();
