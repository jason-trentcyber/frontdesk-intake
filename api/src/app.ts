import type { Db } from "@frontdesk/db";
import Fastify, { type FastifyInstance } from "fastify";
import { registerHealthzRoute } from "./routes/healthz.js";
import { registerIndexInfoRoute } from "./routes/index-info.js";
import { registerReadyzRoute } from "./routes/readyz.js";
import { registerRequestsRoute } from "./routes/requests.js";
import type { Queue, TriageMessage } from "./queue/index.js";
import type { TurnstileVerifier } from "./turnstile.js";

export interface AppDeps {
  db: Db;
  queue: Queue<TriageMessage>;
  verifyTurnstile: TurnstileVerifier;
  publicWebOrigin: string;
}

// Separate from server.ts (which also calls .listen()) so route tests can
// build an app and use Fastify's inject() without binding a real socket.
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: true });

  registerHealthzRoute(app);
  registerReadyzRoute(app, deps.db);
  registerRequestsRoute(app, deps);
  registerIndexInfoRoute(app, deps.db);

  return app;
}
