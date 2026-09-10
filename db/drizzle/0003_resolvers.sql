-- ADR-0018 §Row-level security "Entry-point resolvers": the three
-- pre-context reads (staff sign-in by email, an API key by hash, a
-- tracking token) that must happen before an org context exists. Each is
-- SECURITY DEFINER, owned by frontdesk (the role running this
-- migration - table owners bypass RLS by default, which is exactly what
-- lets these look across every org to find the one row that matters),
-- SET search_path = public (fixed search_path is required for
-- SECURITY DEFINER functions - an attacker-controlled search_path could
-- otherwise redirect an unqualified reference to a function/operator the
-- caller controls). They return only identifiers, never a row's data, so
-- the unscoped surface is exactly these three functions, not a table.
CREATE FUNCTION resolve_membership(p_email citext)
RETURNS TABLE (org_id uuid, role member_role)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT org_members.org_id, org_members.role
  FROM org_members
  WHERE org_members.email = p_email
$$;
--> statement-breakpoint

-- Updates last_used_at and ignores revoked keys in the same statement
-- (one round trip, no separate UPDATE from the caller - the caller has
-- no org context yet to scope one).
CREATE FUNCTION resolve_api_key(p_key_hash text)
RETURNS TABLE (org_id uuid, api_key_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE api_keys
  SET last_used_at = now()
  WHERE key_hash = p_key_hash AND revoked_at IS NULL
  RETURNING api_keys.org_id, api_keys.id
$$;
--> statement-breakpoint

CREATE FUNCTION resolve_tracking(p_token text)
RETURNS TABLE (org_id uuid, request_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT requests.org_id, requests.id
  FROM requests
  WHERE requests.tracking_token = p_token
$$;
--> statement-breakpoint

REVOKE ALL ON FUNCTION resolve_membership(citext) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_api_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION resolve_tracking(text) FROM PUBLIC;
--> statement-breakpoint

GRANT EXECUTE ON FUNCTION resolve_membership(citext) TO frontdesk_app;
GRANT EXECUTE ON FUNCTION resolve_api_key(text) TO frontdesk_app;
GRANT EXECUTE ON FUNCTION resolve_tracking(text) TO frontdesk_app;
