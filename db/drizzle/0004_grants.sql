-- ADR-0018 §Schema: orgs is read-only from the app role in v1 - org
-- configuration changes by seed or migration until a settings UI is a
-- requirement. default privileges already grant SELECT (002-roles.sh),
-- so only the write verbs need revoking.
REVOKE INSERT, UPDATE, DELETE ON orgs FROM frontdesk_app;
--> statement-breakpoint

-- drizzle-orm's migrator creates drizzle.__drizzle_migrations itself
-- (verified against its node-postgres dialect source: default schema
-- "drizzle", default table "__drizzle_migrations") before applying any
-- migration in this file's run, so it already exists by the time this
-- statement runs - the IF EXISTS guard is defensive only, in case a
-- future migration tool is swapped in and applies this file without that
-- side effect. frontdesk_app was never granted anything on the drizzle
-- schema (002-roles.sh only sets default privileges on public and pgmq),
-- so this is belt and braces, not undoing an existing grant.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'drizzle' AND table_name = '__drizzle_migrations'
  ) THEN
    REVOKE ALL ON drizzle.__drizzle_migrations FROM frontdesk_app;
  END IF;
END $$;
