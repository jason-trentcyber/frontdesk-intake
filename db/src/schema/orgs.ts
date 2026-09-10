import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Not a tenant table: no org_id, no RLS. Read-only from frontdesk_app in
// v1 (drizzle/0004_grants.sql revokes INSERT/UPDATE/DELETE) - org
// configuration changes by seed or migration until a settings UI is a
// requirement (ADR-0018).
export const orgs = pgTable("orgs", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  isDemo: boolean("is_demo").notNull().default(false),
  dailyTokenBudget: integer("daily_token_budget").notNull().default(200000),
  // Shape validated by db/src/settings.ts's zod schema at the application
  // boundary, not by a DB constraint.
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
