import { sql } from "drizzle-orm";
import { integer, pgPolicy, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { bytea } from "./custom-types.js";
import { documentStatus } from "./enums.js";
import { orgs } from "./orgs.js";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id")
      .notNull()
      .references(() => orgs.id),
    title: text("title").notNull(),
    filename: text("filename").notNull(),
    mime: text("mime").notNull(),
    sha256: text("sha256").notNull(),
    raw: bytea("raw").notNull(),
    textContent: text("text_content"),
    status: documentStatus("status").notNull().default("pending"),
    chunkCount: integer("chunk_count").notNull().default(0),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Referenced compositely by chunks (org_id, document_id) -> (org_id, id).
    unique("documents_org_id_id_unique").on(t.orgId, t.id),
    unique("documents_org_id_sha256_unique").on(t.orgId, t.sha256),
    pgPolicy("org_isolation", {
      for: "all",
      to: "frontdesk_app",
      using: sql`org_id = current_org_id()`,
      withCheck: sql`org_id = current_org_id()`,
    }),
  ],
).enableRLS();
