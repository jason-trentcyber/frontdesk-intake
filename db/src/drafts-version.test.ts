import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db } from "./client.js";

const ownerUrl = process.env.DATABASE_URL;
const appUrl = process.env.DATABASE_APP_URL;
const hasEnv = Boolean(ownerUrl && appUrl);

// Needs a live, seeded Postgres - same gate and same named-skip reason as
// rls.test.ts, so `pnpm test` at the root still passes without Postgres
// running and the skip stays visible in the vitest summary.
describe.skipIf(!hasEnv)(
  hasEnv
    ? "drafts version uniqueness"
    : "drafts version uniqueness [skipped: DATABASE_URL/DATABASE_APP_URL not set]",
  () => {
    let ownerDb: Db;
    let demoOrgId: string;
    const createdRequestIds: string[] = [];

    beforeAll(async () => {
      ownerDb = createDb(ownerUrl!);
      const orgs = await ownerDb.execute<{ id: string }>(
        sql`select id from orgs where slug = 'bright-smile-dental'`,
      );
      const demo = orgs.rows[0];
      if (!demo) {
        throw new Error("expected seed data (bright-smile-dental) - run `pnpm seed` first");
      }
      demoOrgId = demo.id;
    });

    afterAll(async () => {
      // drafts cascade from requests (composite FK, ON DELETE CASCADE).
      for (const id of createdRequestIds) {
        await ownerDb.execute(sql`delete from requests where id = ${id}::uuid`);
      }
    });

    async function asApp<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
      const client = new pg.Client({ connectionString: appUrl });
      await client.connect();
      try {
        await client.query("select set_config('app.org_id', $1, false)", [demoOrgId]);
        return await fn(client);
      } finally {
        await client.end();
      }
    }

    async function makeRequest(client: pg.Client): Promise<string> {
      const res = await client.query(
        "insert into requests (org_id, source, subject, body, tracking_token, status) " +
          "values ($1, 'form', 'drafts-version-test', 'body', $2, 'drafted') returning id",
        [demoOrgId, `drafts-version-${randomUUID()}`],
      );
      const id = (res.rows[0] as { id: string }).id;
      createdRequestIds.push(id);
      return id;
    }

    async function insertDraft(client: pg.Client, requestId: string, version: number) {
      return client.query(
        "insert into drafts (org_id, request_id, version, body, confidence, model, prompt_version) " +
          "values ($1, $2, $3, 'draft body', 0.5, 'test', 'v1')",
        [demoOrgId, requestId, version],
      );
    }

    // The invariant 26b's detail page and edit-then-approve flow rest on:
    // "the current draft is the highest version" is only unambiguous if a
    // version cannot be duplicated. Both writers (worker/'s triage
    // pipeline and web/'s editApproveRequestAction) compute N+1 from a
    // read, which is not atomic across concurrent transactions - so the
    // database, not the application, has to forbid the collision.
    it("rejects a second draft at the same version for the same request", async () => {
      await asApp(async (client) => {
        const requestId = await makeRequest(client);
        await insertDraft(client, requestId, 1);
        await expect(insertDraft(client, requestId, 1)).rejects.toThrow(
          /duplicate key value violates unique constraint/i,
        );
      });
    });

    it("allows the same version number on a different request", async () => {
      await asApp(async (client) => {
        const firstId = await makeRequest(client);
        const secondId = await makeRequest(client);
        await insertDraft(client, firstId, 1);
        // Scoped to (org_id, request_id, version), not (org_id, version):
        // every request numbers its own drafts from 1.
        await expect(insertDraft(client, secondId, 1)).resolves.toBeTruthy();
      });
    });

    it("allows successive versions on the same request", async () => {
      await asApp(async (client) => {
        const requestId = await makeRequest(client);
        await insertDraft(client, requestId, 1);
        await expect(insertDraft(client, requestId, 2)).resolves.toBeTruthy();
      });
    });
  },
);
