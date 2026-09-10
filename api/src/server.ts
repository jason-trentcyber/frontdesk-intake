import { createDb } from "@frontdesk/db";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";
import { createQueue } from "./queue/create.js";
import { createTurnstileVerifier } from "./turnstile.js";

const env = loadEnv();
const db = createDb(env.databaseUrl);
const queue = createQueue(env, db);
const verifyTurnstile = createTurnstileVerifier(env.TURNSTILE_SECRET_KEY ?? "");

const app = buildApp({ db, queue, verifyTurnstile, publicWebOrigin: env.PUBLIC_WEB_ORIGIN });

app.listen({ port: env.PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exitCode = 1;
  }
});
