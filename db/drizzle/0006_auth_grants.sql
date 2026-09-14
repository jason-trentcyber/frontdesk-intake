-- ADR-0031: frontdesk_app needs DML on the auth schema Auth.js's adapter
-- reads and writes every request (session lookups, OAuth account links,
-- user upserts). deploy/postgres/initdb/002-roles.sh's default-privilege
-- grants only cover the public and pgmq schemas (ADR-0016) - auth is new
-- in this migration, so it gets its own explicit grant here, the same
-- shape 002-roles.sh uses for public/pgmq, not a default-privileges rule
-- (there is no future auth.* table expected beyond the four this PR
-- creates, unlike pgmq's create-at-runtime queue tables).
GRANT USAGE ON SCHEMA auth TO frontdesk_app;
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA auth TO frontdesk_app;
