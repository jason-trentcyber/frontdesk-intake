export interface Env {
  databaseUrl: string;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
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
  return { databaseUrl };
}
