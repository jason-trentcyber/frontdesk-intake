import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerHealthzRoute } from "./healthz.js";

describe("GET /healthz", () => {
  it("returns 200 with no database dependency", async () => {
    const app = Fastify();
    registerHealthzRoute(app);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
