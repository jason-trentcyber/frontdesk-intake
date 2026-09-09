#!/usr/bin/env bash
# Two roles from day one, before Prisma (#21) ever connects (ADR-0016):
# ADR-0007's RLS layer only works for a role without BYPASSRLS - a
# superuser bypasses RLS silently.
#   frontdesk      - database owner, runs Prisma migrations
#   frontdesk_app  - runtime, DML only, via default privileges set below
# The `postgres` superuser (POSTGRES_USER, unchanged) is used by the
# container entrypoint and the backup CronJob only; nothing app-facing
# ever authenticates as it.
#
# A shell script (not .sql) so it can read FRONTDESK_PASSWORD /
# FRONTDESK_APP_PASSWORD from the environment; passwords are passed to
# psql as `-v` variables and substituted with `:'var'` (quoted as a SQL
# string literal) rather than interpolated into the heredoc by the shell,
# so a password containing quotes or `$` can't break the SQL. No
# IF-NOT-EXISTS guard: docker-entrypoint-initdb.d scripts only run once,
# against a freshly initialized (empty) data directory, so a plain
# CREATE ROLE is safe - it also sidesteps psql's `:'var'` substitution
# not applying inside a dollar-quoted DO $$ ... $$ block, which a guarded
# version would need.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
	-v frontdesk_password="$FRONTDESK_PASSWORD" \
	-v frontdesk_app_password="$FRONTDESK_APP_PASSWORD" <<-'EOSQL'
	CREATE ROLE frontdesk NOSUPERUSER NOBYPASSRLS NOCREATEDB LOGIN PASSWORD :'frontdesk_password';
	CREATE ROLE frontdesk_app NOSUPERUSER NOBYPASSRLS NOCREATEDB LOGIN PASSWORD :'frontdesk_app_password';

	ALTER DATABASE frontdesk OWNER TO frontdesk;

	GRANT USAGE ON SCHEMA public, pgmq TO frontdesk_app;
	ALTER DEFAULT PRIVILEGES FOR ROLE frontdesk IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO frontdesk_app;
	ALTER DEFAULT PRIVILEGES FOR ROLE frontdesk IN SCHEMA public
	  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO frontdesk_app;

	-- pgmq's own functions have no SECURITY DEFINER (checked
	-- pgmq--1.13.0.sql), so pgmq.create() runs pgmq's internal
	-- `CREATE TABLE pgmq.q_<name>/a_<name>` as whichever role calls it.
	-- frontdesk_app therefore needs CREATE on the schema itself, not just
	-- USAGE, and ends up owning the queue tables it creates - which is
	-- exactly the access it needs on them, no further grant required.
	GRANT CREATE ON SCHEMA pgmq TO frontdesk_app;
	GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgmq TO frontdesk_app;
	ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq GRANT EXECUTE ON FUNCTIONS TO frontdesk_app;

	-- CREATE EXTENSION pgmq (001-extensions.sql) runs as postgres and
	-- already owns pgmq's own admin tables (meta, notify_insert_throttle,
	-- topic_bindings) - default privileges only cover objects created
	-- *after* the ALTER, so those pre-existing ones need a direct grant.
	-- Mirrors the ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq ... pattern
	-- pgmq's own SQL uses for pg_monitor (no FOR ROLE = "for postgres",
	-- the role running this script), so a future extension upgrade that
	-- adds another postgres-owned admin table stays covered too.
	GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgmq TO frontdesk_app;
	GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA pgmq TO frontdesk_app;
	ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO frontdesk_app;
	ALTER DEFAULT PRIVILEGES IN SCHEMA pgmq GRANT USAGE, SELECT ON SEQUENCES TO frontdesk_app;
	EOSQL
