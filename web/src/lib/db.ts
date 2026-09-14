import { createDb, type Db } from "@frontdesk/db";
import { loadEnv } from "./env";

// Postgres's own config (deploy/chart/values.yaml postgres.config.
// max_connections: 60) is a fixed budget shared, on one node, with api/'s
// pool (pg default max 10, one replica) and worker/'s pool (asyncpg
// default max 10, one replica). The tracking page does exactly one
// SECURITY DEFINER resolve plus one org-scoped select per request - the
// lightest per-request DB work of any consumer - so it takes a
// deliberately smaller slice of that shared budget rather than inheriting
// the same default every heavier consumer already uses.
const POOL_MAX = 5;

declare global {
  // Next's dev server (`next dev`) re-evaluates route modules on every
  // HMR reload. Without a globalThis-keyed singleton, each reload would
  // construct a fresh pg.Pool and leak the previous one's connections
  // instead of reusing it - the standard Next.js pattern for anything
  // stateful at module scope, and the reason this isn't "one pool per
  // request" either: a pool is meant to be held for the process lifetime.
  var __frontdeskDb: Db | undefined;
}

export function getDb(): Db {
  if (!globalThis.__frontdeskDb) {
    globalThis.__frontdeskDb = createDb(loadEnv().databaseUrl, { max: POOL_MAX });
  }
  return globalThis.__frontdeskDb;
}
