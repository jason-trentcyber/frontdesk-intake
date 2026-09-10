import { randomUUID } from "node:crypto";
import { createDb, type Db } from "@frontdesk/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresQueue } from "./pgmq.js";
import { ensureQueue } from "./ensure.js";

// ensureQueue() is the one DDL statement api/ issues, and the thing that
// stands between a fresh deployment and a 500 on the first intake. Its
// idempotency was originally verified by hand; this pins it in CI.
const pgUrl = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;
const hasEnv = Boolean(pgUrl);

describe.skipIf(!hasEnv)(
  hasEnv ? "ensureQueue" : "ensureQueue [skipped: DATABASE_APP_URL/DATABASE_URL not set]",
  () => {
    // pgmq caps queue names at 47 chars (validate_queue_name).
    const queueName = `ensure_test_${randomUUID().slice(0, 8)}`;
    let db: Db;

    beforeAll(() => {
      db = createDb(pgUrl!);
    });

    afterAll(async () => {
      await db.execute(sql`select pgmq.drop_queue(${queueName})`);
    });

    it("pgmq.send fails before the queue exists - this is why ensureQueue runs at startup", async () => {
      const queue = new PostgresQueue<{ hello: string }>(db, queueName);
      // Drizzle wraps the driver error ("Failed query: ..."); the Postgres
      // message we care about is on .cause.
      const err = await queue.send({ hello: "before" }).then(
        () => undefined,
        (e: Error) => e,
      );
      expect(err).toBeDefined();
      expect(String((err as Error & { cause?: Error }).cause?.message)).toMatch(/does not exist/);
    });

    it("creates the queue", async () => {
      await ensureQueue(db, queueName);
      const result = await db.execute<{ queue_name: string }>(
        sql`select queue_name from pgmq.list_queues() where queue_name = ${queueName}`,
      );
      expect(result.rows).toHaveLength(1);
    });

    it("is idempotent - a second call succeeds", async () => {
      await expect(ensureQueue(db, queueName)).resolves.toBeUndefined();
    });

    it("leaves the queue tables owned by the connecting role, not the owner role", async () => {
      // initdb/002-roles.sh grants CREATE ON SCHEMA pgmq to frontdesk_app
      // precisely so the app role owns what it creates. If this ever flips
      // to `frontdesk`, the app loses access to its own queue.
      const owner = await db.execute<{ tableowner: string }>(
        sql`select tableowner from pg_tables where schemaname = 'pgmq' and tablename = ${"q_" + queueName}`,
      );
      const me = await db.execute<{ current_user: string }>(sql`select current_user`);
      expect(owner.rows[0]?.tableowner).toBe(me.rows[0]?.current_user);
    });

    it("the queue works after ensureQueue - send then receive", async () => {
      const queue = new PostgresQueue<{ hello: string }>(db, queueName);
      const id = await queue.send({ hello: "after" });
      expect(id).toBeTruthy();
      const [msg] = await queue.receive(30);
      expect(msg?.body).toEqual({ hello: "after" });
      await queue.ack(msg!.id);
    });
  },
);
