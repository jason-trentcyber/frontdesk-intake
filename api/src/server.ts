import { createDb } from "@frontdesk/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createIngestQueue, createQueue } from "./queue/create.js";
import { ensureQueue } from "./queue/ensure.js";
import { INGEST_QUEUE_NAME } from "./queue/index.js";
import { enqueuePendingIngestMessages } from "./queue/seed-ingest.js";
import { createTurnstileVerifier } from "./turnstile.js";

const env = loadEnv();
const db = createDb(env.databaseUrl);
const queue = createQueue(env, db);
const ingestQueue = createIngestQueue(env, db);
const verifyTurnstile = createTurnstileVerifier(env.TURNSTILE_SECRET_KEY ?? "");

const app = buildApp({ db, queue, verifyTurnstile, publicWebOrigin: env.PUBLIC_WEB_ORIGIN });

async function main(): Promise<void> {
  // pgmq only: SQS queues are created by whatever provisions the AWS
  // account, not by this process. Idempotent, and it must happen before
  // the first request - pgmq.send() does not auto-create a missing queue
  // (see ensure.ts). ADR-0025 §1: both queues, same reasoning.
  if (env.QUEUE_PROVIDER === "pgmq") {
    await ensureQueue(db);
    await ensureQueue(db, INGEST_QUEUE_NAME);
  }
  // ADR-0025 §3: the only trigger for the documents db/src/seed.ts creates
  // at status='pending' - #24 has no upload route yet. Provider-agnostic
  // (send() doesn't care which adapter backs it), so this isn't gated on
  // QUEUE_PROVIDER the way ensureQueue is - it just needs a Queue.
  const enqueued = await enqueuePendingIngestMessages(db, ingestQueue);
  app.log.info({ enqueued }, "enqueued pending documents for ingestion");
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  app.log.error(err);
  process.exitCode = 1;
});
