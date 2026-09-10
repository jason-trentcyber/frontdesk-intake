import { customType } from "drizzle-orm/pg-core";

// Case-insensitive text. Trusted on the pinned image (verified against a
// running container: citext.control has `trusted = true`, so the
// `frontdesk` owner role can CREATE EXTENSION it directly - no superuser,
// no image bump. Created in drizzle/0000_extensions_assert.sql.
export const citext = customType<{ data: string }>({
  dataType() {
    return "citext";
  },
});

// Only ever produced by chunks.tsv's `.generatedAlwaysAs(...)` - nothing
// writes a tsvector value directly, so no driver-value mapping is needed.
export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

// documents.raw: no built-in bytea type in drizzle-orm/pg-core.
export const bytea = customType<{ data: Buffer }>({
  dataType() {
    return "bytea";
  },
});
