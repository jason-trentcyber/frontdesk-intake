import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

// Needs a live, seeded Postgres (`make up`, `pnpm --filter @frontdesk/db
// migrate`, `pnpm seed`) - skips with a named reason, visible in the
// vitest summary, rather than failing, so `pnpm test` at the root still
// passes without Postgres running.
describe.skipIf(!hasEnv)(
  hasEnv ? "row-level security (ADR-0018)" : "row-level security (ADR-0018) [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let demoOrgId: string;
    let otherOrgId: string;
    let seedOwnerEmail: string;

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      const orgs = await ownerDb.execute<{ id: string; slug: string }>(sql`select id, slug from orgs`);
      const demo = orgs.rows.find((o) => o.slug === "bright-smile-dental");
      const other = orgs.rows.find((o) => o.slug === "harbor-legal");
      if (!demo || !other) {
        throw new Error("expected seed data (bright-smile-dental, harbor-legal) - run `pnpm seed` first");
      }
      demoOrgId = demo.id;
      otherOrgId = other.id;
      const base = process.env.SEED_OWNER_EMAIL ?? "owner@example.com";
      const at = base.indexOf("@");
      seedOwnerEmail = `${base.slice(0, at)}+bright-smile-dental${base.slice(at)}`;
    });

    async function asApp<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
      const client = new pg.Client({ connectionString: appUrl });
      await client.connect();
      try {
        return await fn(client);
      } finally {
        await client.end();
      }
    }

    it("returns zero rows without an org context", async () => {
      await asApp(async (client) => {
        const res = await client.query("select count(*)::int as count from requests");
        expect(res.rows[0].count).toBe(0);
      });
    });

    it("returns the seeded rows once an org context is set", async () => {
      await asApp(async (client) => {
        await client.query("select set_config('app.org_id', $1, false)", [demoOrgId]);
        const res = await client.query("select count(*)::int as count from requests");
        expect(res.rows[0].count).toBeGreaterThan(0);
      });
    });

    it("rejects a cross-org insert (WITH CHECK)", async () => {
      await expect(
        asApp(async (client) => {
          await client.query("select set_config('app.org_id', $1, false)", [demoOrgId]);
          await client.query(
            "insert into requests (org_id, source, subject, body, tracking_token, status) values ($1, 'form', 'x', 'x', $2, 'received')",
            [otherOrgId, `rls-test-${randomUUID()}`],
          );
        }),
      ).rejects.toThrow(/row-level security/i);
    });

    it("leaves actions unmodified - no UPDATE policy exists, so it matches zero rows rather than erroring (append-only, ADR-0018)", async () => {
      await asApp(async (client) => {
        await client.query("select set_config('app.org_id', $1, false)", [demoOrgId]);
        const before = await client.query("select id, reason from actions limit 1");
        if (before.rows.length === 0) {
          throw new Error("expected at least one seeded action - run `pnpm seed` first");
        }
        const target = before.rows[0] as { id: string; reason: string | null };
        const res = await client.query("update actions set reason = 'rls-test' where id = $1", [target.id]);
        expect(res.rowCount).toBe(0);
        const after = await client.query("select reason from actions where id = $1", [target.id]);
        expect((after.rows[0] as { reason: string | null }).reason).toBe(target.reason);
      });
    });

    it("rejects any write to orgs - read-only from the app role in v1", async () => {
      await expect(
        asApp(async (client) => {
          await client.query("update orgs set name = 'rls-test' where id = $1", [demoOrgId]);
        }),
      ).rejects.toThrow(/permission denied/i);
    });

    it("resolve_membership finds the seeded owner", async () => {
      await asApp(async (client) => {
        const res = await client.query("select * from resolve_membership($1)", [seedOwnerEmail]);
        expect(res.rows).toHaveLength(1);
        const row = res.rows[0] as { org_id: string; role: string };
        expect(row.org_id).toBe(demoOrgId);
        expect(row.role).toBe("owner");
      });
    });

    it("resolve_membership returns nothing for an unknown email", async () => {
      await asApp(async (client) => {
        const res = await client.query("select * from resolve_membership($1)", [`nobody-${randomUUID()}@example.com`]);
        expect(res.rows).toHaveLength(0);
      });
    });
  },
);
