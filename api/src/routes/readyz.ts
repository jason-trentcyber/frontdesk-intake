import type { Db } from "@frontdesk/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { sendProblem } from "../problem.js";

// Readiness: one SELECT 1. The chart's readinessProbe hits this so a
// pod is pulled from rotation while the DB is unreachable, without
// killing the pod the way a failing livenessProbe would.
export function registerReadyzRoute(app: FastifyInstance, db: Db): void {
  app.get("/readyz", async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: "ok" };
    } catch (err) {
      app.log.error({ err }, "readyz: database check failed");
      return sendProblem(reply, 503, "Not Ready", "database check failed");
    }
  });
}
