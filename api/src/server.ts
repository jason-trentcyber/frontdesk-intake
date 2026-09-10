import { createDb } from "@frontdesk/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createQueue } from "./queue/create.js";
import { ensureQueue } from "./queue/ensure.js";
import { createTurnstileVerifier } from "./turnstile.js";

const env = loadEnv();
const db = createDb(env.databaseUrl);
const queue = createQueue(env, db);
const verifyTurnstile = createTurnstileVerifier(env.TURNSTILE_SECRET_KEY ?? "");

const app = buildApp({ db, queue, verifyTurnstile, publicWebOrigin: env.PUBLIC_WEB_ORIGIN });

async function main(): Promise<void> {
  // pgmq only: SQS queues are created by whatever provisions the AWS
  // account, not by this process. Idempotent, and it must happen before
  // the first request - pgmq.send() does not auto-create a missing queue
  // (see ensure.ts).
  if (env.QUEUE_PROVIDER === "pgmq") {
    await ensureQueue(db);
  }
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
}

main().catch((err: unknown) => {
  app.log.error(err);
  process.exitCode = 1;
});
