import { createDb, type Db } from "@frontdesk/db";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerReadyzRoute } from "./readyz.js";

const appUrl = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;

describe("GET /readyz", () => {
  it.skipIf(!appUrl)("returns 200 when the database is reachable", async () => {
    const app = Fastify();
    registerReadyzRoute(app, createDb(appUrl!));
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(200);
  });

  it("returns 503 problem+json when the database check fails - no live DB needed for this one", async () => {
    const app = Fastify();
    const brokenDb = { execute: () => Promise.reject(new Error("connection refused")) } as unknown as Db;
    registerReadyzRoute(app, brokenDb);
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.headers["content-type"]).toContain("application/problem+json");
  });
});
