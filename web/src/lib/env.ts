export interface Env {
  databaseUrl: string;
  apiOrigin: string;
  turnstileSiteKey: string;
}

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  // Production (the chart's deployment.yaml, ADR-0017/0021/0027) sets only
  // DATABASE_URL, built by Kubernetes $(VAR) expansion from the
  // frontdesk_app role - same reasoning as api/src/env.ts. Locally,
  // .env.example's DATABASE_URL is the *owner* role (db/'s migrate/seed)
  // and DATABASE_APP_URL is the runtime role; web must never run as the
  // owner role, so DATABASE_APP_URL wins when both are set.
  const databaseUrl = source.DATABASE_APP_URL ?? source.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or DATABASE_APP_URL locally) is required");
  }

  // 27b: web's public-form Server Action calls api/'s intake path
  // server-side (ADR-0021), pod-to-pod in the cluster. No default, same
  // reasoning as api/src/env.ts's PUBLIC_WEB_ORIGIN - a default
  // necessarily names one environment's address, so a misconfigured
  // deployment would silently call the wrong place instead of failing
  // loudly.
  const apiOrigin = source.API_ORIGIN;
  if (!apiOrigin) {
    throw new Error("API_ORIGIN is required");
  }

  // The Turnstile *site* key is public (safe in a ConfigMap, unlike the
  // secret key api/ verifies with) but still required, not defaulted: a
  // missing key should fail the render loudly rather than silently ship
  // a form with no working challenge widget.
  const turnstileSiteKey = source.TURNSTILE_SITE_KEY;
  if (!turnstileSiteKey) {
    throw new Error("TURNSTILE_SITE_KEY is required");
  }

  return { databaseUrl, apiOrigin, turnstileSiteKey };
}
