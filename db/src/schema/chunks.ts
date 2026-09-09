import { sql } from "drizzle-orm";
import { foreignKey, index, integer, pgPolicy, pgTable, text, timestamp, unique, uuid, vector } from "drizzle-orm/pg-core";
import { tsvector } from "./custom-types.js";
import { documents } from "./documents.js";

export const chunks = pgTable(
  "chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: uuid("org_id").notNull(),
    documentId: uuid("document_id").notNull(),
    ord: integer("ord").notNull(),
    text: text("text").notNull(),
    tsv: tsvector("tsv")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english', text)`),
    // bge-small-en-v1.5, 384 dims (ADR-0005). Nullable: a chunk exists
    // (and is full-text searchable via tsv) before the worker embeds it.
    embedding: vector("embedding", { dimensions: 384 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    foreignKey({
      columns: [t.orgId, t.documentId],
      foreignColumns: [documents.orgId, documents.id],
    }).onDelete("cascade"),
    unique("chunks_document_id_ord_unique").on(t.documentId, t.ord),
    index("chunks_embedding_hnsw")
      .using("hnsw", t.embedding.op("vector_cosine_ops"))
      .with({ m: 16, ef_construction: 64 }),
    index("chunks_tsv_gin").using("gin", t.tsv),
    pgPolicy("org_isolation", {
      for: "all",
      to: "frontdesk_app",
      using: sql`org_id = current_org_id()`,
      withCheck: sql`org_id = current_org_id()`,
    }),
  ],
).enableRLS();
