// Three independent loaders, not one combined Env - each has exactly one
// consumer, and bundling them made every consumer require every var:
// /t/[token] (getDb() only) started throwing on a missing API_ORIGIN/
// TURNSTILE_SITE_KEY it has no use for at all (review, #112). Every
// production Deployment env block does set all three together today, so
// this split doesn't change production behavior - it changes what a
// future caller that only needs one of them is forced to provide.

/**
 * Production (the chart's deployment.yaml, ADR-0017/0021/0027) sets only
 * DATABASE_URL, built by Kubernetes $(VAR) expansion from the
 * frontdesk_app role - same reasoning as api/src/env.ts. Locally,
 * .env.example's DATABASE_URL is the *owner* role (db/'s migrate/seed)
 * and DATABASE_APP_URL is the runtime role; web must never run as the
 * owner role, so DATABASE_APP_URL wins when both are set.
 */
export function loadDatabaseUrl(source: Record<string, string | undefined> = process.env): string {
  const databaseUrl = source.DATABASE_APP_URL ?? source.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or DATABASE_APP_URL locally) is required");
  }
  return databaseUrl;
}

/**
 * 27b: web's public-form Server Action calls api/'s intake path
 * server-side (ADR-0021), pod-to-pod in the cluster. No default, same
 * reasoning as api/src/env.ts's PUBLIC_WEB_ORIGIN - a default
 * necessarily names one environment's address, so a misconfigured
 * deployment would silently call the wrong place instead of failing
 * loudly.
 */
export function loadApiOrigin(source: Record<string, string | undefined> = process.env): string {
  const apiOrigin = source.API_ORIGIN;
  if (!apiOrigin) {
    throw new Error("API_ORIGIN is required");
  }
  return apiOrigin;
}

/**
 * The Turnstile *site* key is public (safe in a ConfigMap, unlike the
 * secret key api/ verifies with) but still required, not defaulted: a
 * missing key should fail the render loudly rather than silently ship a
 * form with no working challenge widget.
 */
export function loadTurnstileSiteKey(
  source: Record<string, string | undefined> = process.env,
): string {
  const turnstileSiteKey = source.TURNSTILE_SITE_KEY;
  if (!turnstileSiteKey) {
    throw new Error("TURNSTILE_SITE_KEY is required");
  }
  return turnstileSiteKey;
}
