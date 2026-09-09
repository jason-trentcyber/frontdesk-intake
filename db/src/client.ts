import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(connectionString: string): Db {
  return drizzle(new pg.Pool({ connectionString }), { schema });
}

// The only table not scoped by org_id (ADR-0018) - read directly off a
// plain Db, never through forOrg. Also the coverage test's allow-list.
export const NON_TENANT_TABLES = ["orgs"] as const;

/**
 * Runs `fn` inside one transaction that first sets `app.org_id` for every
 * RLS policy in this transaction to compare against (ADR-0018). The GUC
 * is transaction-local (`set_config(..., true)`), so a pooled connection
 * can never leak a context into an unrelated request.
 *
 * `fn` also receives `orgId` back so callers carry it explicitly in their
 * own `where`/`insert` - RLS is the backstop, not the only line.
 */
export async function forOrg<T>(
  db: Db,
  orgId: string,
  fn: (tx: Db, orgId: string) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx, orgId);
  });
}

export interface Membership {
  orgId: string;
  role: "owner" | "staff";
}

/** Staff sign-in by email (ADR-0003). Unknown email -> null, not an error. */
export async function resolveMembership(db: Db, email: string): Promise<Membership | null> {
  const result = await db.execute<{ org_id: string; role: "owner" | "staff" }>(
    sql`select * from resolve_membership(${email})`,
  );
  const row = result.rows[0];
  return row ? { orgId: row.org_id, role: row.role } : null;
}

export interface ApiKeyResolution {
  orgId: string;
  apiKeyId: string;
}

/** F3 API auth. Stamps last_used_at; ignores revoked keys (both server-side, in resolve_api_key). */
export async function resolveApiKey(db: Db, keyHash: string): Promise<ApiKeyResolution | null> {
  const result = await db.execute<{ org_id: string; api_key_id: string }>(
    sql`select * from resolve_api_key(${keyHash})`,
  );
  const row = result.rows[0];
  return row ? { orgId: row.org_id, apiKeyId: row.api_key_id } : null;
}

export interface TrackingResolution {
  orgId: string;
  requestId: string;
}

/** F2 tracking page, /t/<token>. */
export async function resolveTracking(db: Db, token: string): Promise<TrackingResolution | null> {
  const result = await db.execute<{ org_id: string; request_id: string }>(
    sql`select * from resolve_tracking(${token})`,
  );
  const row = result.rows[0];
  return row ? { orgId: row.org_id, requestId: row.request_id } : null;
}
