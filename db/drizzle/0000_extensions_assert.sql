-- ADR-0018 "What the schema language cannot express... goes in
-- drizzle-kit generate --custom migration files". Runs first (renumbered
-- ahead of the generated schema migration - see db/README.md "Migration
-- order" for why 0000 could not stay the generated file as originally
-- briefed): 0002_schema.sql's CREATE TABLE statements reference the
-- citext type directly (org_members.email), so citext must exist before
-- it runs.
--
-- vector and pgmq are asserted, not created here - they're baked into
-- every environment by deploy/postgres/initdb/001-extensions.sql
-- (superuser, container start; ADR-0016). This is a defensive check that
-- the image is the right one, not how those two get created.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'pgvector missing: image must be deploy/postgres (ADR-0016)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgmq') THEN
    RAISE EXCEPTION 'pgmq missing: image must be deploy/postgres (ADR-0016)';
  END IF;
END $$;
--> statement-breakpoint

-- citext IS trusted on this image (verified against a running container:
-- citext.control has `trusted = true`), so the frontdesk owner role
-- (NOSUPERUSER, ADR-0016) can create it directly - no image bump needed.
CREATE EXTENSION IF NOT EXISTS citext;
