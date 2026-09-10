-- ADR-0018 §Row-level security: the STABLE helper every policy's
-- USING/WITH CHECK compares org_id against. Unset or empty app.org_id ->
-- NULL -> org_id = NULL is never true, so a missing context yields zero
-- rows, never an error and never everything.
--
-- Must exist before 0002_schema.sql's CREATE POLICY statements, which
-- reference it by name (Postgres resolves function references at policy
-- creation time) - the other half of why this migration was renumbered
-- ahead of the generated schema file.
CREATE FUNCTION current_org_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid
$$;
