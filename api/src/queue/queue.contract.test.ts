import { randomUUID } from "node:crypto";
import { CreateQueueCommand, DeleteQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createDb, type Db } from "@frontdesk/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queue } from "./index.js";
import { PostgresQueue } from "./pgmq.js";
import { SqsQueue } from "./sqs.js";

// ADR-0004's whole acceptance criterion: identical behaviour from both
// adapters, one parameterised test file. Each fixture skips with a named
// reason (same pattern as db/src/rls.test.ts) when its backing service
// isn't configured, so `pnpm test` at the repo root stays green without
// Postgres/LocalStack running.

interface TestPayload {
  hello: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AdapterFixture {
  name: string;
  available: boolean;
  reason: string;
  setup: () => Promise<Queue<TestPayload>>;
  teardown: () => Promise<void>;
}

const pgUrl = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;

function pgmqFixture(): AdapterFixture {
  // pgmq queue names are capped at 47 characters (validate_queue_name) -
  // a full UUID doesn't fit alongside a readable prefix.
  const queueName = `frontdesk_triage_test_${randomUUID().slice(0, 8)}`;
  let db: Db;
  return {
    name: "pgmq",
    available: Boolean(pgUrl),
    reason: "DATABASE_APP_URL (or DATABASE_URL) not set",
    async setup() {
      db = createDb(pgUrl!);
      // frontdesk_app has USAGE+CREATE on schema pgmq (verified against
      // the pinned image) - this is test-fixture setup, not the
      // production adapter auto-creating a queue on first send.
      // PostgresQueue never calls pgmq.create() itself; see the PR body
      // for why the db/ migration the brief specified turned out to be
      // impossible for the frontdesk (owner) role.
      await db.execute(sql`select pgmq.create(${queueName})`);
      return new PostgresQueue<TestPayload>(db, queueName);
    },
    async teardown() {
      await db.execute(sql`select pgmq.drop_queue(${queueName})`);
    },
  };
}

const awsEndpoint = process.env.AWS_ENDPOINT_URL;
const awsRegion = process.env.AWS_REGION;

function sqsFixture(): AdapterFixture {
  const queueName = `frontdesk-triage-contract-${randomUUID()}`;
  const dlqName = `${queueName}-dlq`;
  let client: SQSClient;
  let queueUrl: string;
  let dlqUrl: string;
  return {
    name: "sqs",
    available: Boolean(awsEndpoint && awsRegion),
    reason: "AWS_ENDPOINT_URL/AWS_REGION not set",
    async setup() {
      client = new SQSClient({ region: awsRegion, endpoint: awsEndpoint });
      const dlq = await client.send(new CreateQueueCommand({ QueueName: dlqName }));
      const main = await client.send(new CreateQueueCommand({ QueueName: queueName }));
      if (!dlq.QueueUrl || !main.QueueUrl) {
        throw new Error("CreateQueueCommand returned no QueueUrl");
      }
      dlqUrl = dlq.QueueUrl;
      queueUrl = main.QueueUrl;
      return new SqsQueue<TestPayload>({ queueUrl, dlqUrl, region: awsRegion!, endpoint: awsEndpoint });
    },
    async teardown() {
      await client.send(new DeleteQueueCommand({ QueueUrl: queueUrl }));
      await client.send(new DeleteQueueCommand({ QueueUrl: dlqUrl }));
    },
  };
}

function runContractTests(fixture: AdapterFixture): void {
  const title = fixture.available ? `Queue contract: ${fixture.name}` : `Queue contract: ${fixture.name} [skipped: ${fixture.reason}]`;

  describe.skipIf(!fixture.available)(title, () => {
    let queue: Queue<TestPayload>;

    beforeAll(async () => {
      queue = await fixture.setup();
    });

    afterAll(async () => {
      await fixture.teardown();
    });

    it("receive on an empty queue returns empty, not an error", async () => {
      await expect(queue.receive(5)).resolves.toEqual([]);
    });

    it("send then receive returns the payload", async () => {
      await queue.send({ hello: "world-1" });
      const [msg] = await queue.receive(5);
      expect(msg?.body).toEqual({ hello: "world-1" });
      await queue.ack(msg!.id);
    });

    it("a received message is invisible to a second receive within the visibility timeout", async () => {
      await queue.send({ hello: "world-2" });
      const [msg] = await queue.receive(10);
      expect(msg).toBeDefined();
      await expect(queue.receive(10)).resolves.toEqual([]);
      await queue.ack(msg!.id);
    });

    it("ack removes it", async () => {
      await queue.send({ hello: "world-3" });
      const [msg] = await queue.receive(1);
      await queue.ack(msg!.id);
      await sleep(1500); // past the 1s visibility timeout
      const again = await queue.receive(5);
      expect(again.some((m) => m.body.hello === "world-3")).toBe(false);
    });

    it("nack makes it immediately visible", async () => {
      await queue.send({ hello: "world-4" });
      const [msg] = await queue.receive(30);
      expect(msg).toBeDefined();
      await queue.nack(msg!.id);
      const again = await queue.receive(30);
      const redelivered = again.find((m) => m.body.hello === "world-4");
      expect(redelivered).toBeDefined();
      await queue.ack(redelivered!.id);
    });

    it("deadLetter removes it from the main queue", async () => {
      await queue.send({ hello: "world-5" });
      const [msg] = await queue.receive(1);
      expect(msg).toBeDefined();
      await queue.deadLetter(msg!.id);
      await sleep(1500);
      const again = await queue.receive(5);
      expect(again.some((m) => m.body.hello === "world-5")).toBe(false);
    });
  });
}

runContractTests(pgmqFixture());
runContractTests(sqsFixture());
