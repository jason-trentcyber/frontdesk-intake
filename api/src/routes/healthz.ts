import type { FastifyInstance } from "fastify";

// Liveness: no DB call, mirrors web/'s /healthz. The chart's
// livenessProbe hits this - it must not fail when the DB blips (that's
// what /readyz is for).
export function registerHealthzRoute(app: FastifyInstance): void {
  app.get("/healthz", async () => ({ status: "ok" }));
}
