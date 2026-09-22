import type { Db } from "@frontdesk/db";
import Fastify, { type FastifyInstance } from "fastify";
import { genReqId } from "./logging.js";
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
  const app = Fastify({
    logger: true,
    // #29 stage 1 (ADR-0038 §3). Without this, pino labels every request
    // `req-1`, `req-2`, ... from a per-process counter - see logging.ts
    // for why that is not a correlation id.
    //
    // Deliberately NOT paired with `requestIdHeader`. That option looks
    // like the way to honour an inbound header, but it does the opposite
    // of what this needs: reqIdGenFactory returns
    // `req.headers[requestIdHeader] || genReqId(req)` (fastify 5.x,
    // lib/req-id-gen-factory.js), so the raw header value wins and
    // genReqId degrades to a fallback - sanitizeRequestId would never run
    // on the one input an attacker controls. Left at its default (false),
    // genReqId handles every request and reads the header itself.
    genReqId,
  });

  registerHealthzRoute(app);
  registerReadyzRoute(app, deps.db);
  registerRequestsRoute(app, deps);
  registerIndexInfoRoute(app, deps.db);

  return app;
}
