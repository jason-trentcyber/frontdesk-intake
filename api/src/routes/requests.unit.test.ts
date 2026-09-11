import type { Db } from "@frontdesk/db";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Queue, TriageMessage } from "../queue/index.js";
import type { TurnstileVerifier } from "../turnstile.js";
import { registerRequestsRoute } from "./requests.js";

// requests.test.ts runs the route against a real seeded database. This
// file covers the one branch a real database cannot produce: a successful
// INSERT ... RETURNING that comes back with no row. Faking the database is
// the point - the route code under test is the real thing.
const org = {
  id: "11111111-1111-1111-1111-111111111111",
  slug: "bright-smile-dental",
  isDemo: true,
};

function fakeDbReturningNoRow(): Db {
  const tx = {
    execute: vi.fn().mockResolvedValue({ rows: [] }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
  };
  return {
    select: () => ({ from: () => ({ where: async () => [org] }) }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
  } as unknown as Db;
}

describe("POST /requests when the insert returns no row", () => {
  it("fails loudly (500) instead of returning a tracking token for a request that does not exist", async () => {
    const sent: TriageMessage[] = [];
    const queue: Queue<TriageMessage> = {
      send: async (m) => {
        sent.push(m);
        return "should-never-be-called";
      },
      receive: async () => [],
      ack: async () => {},
      nack: async () => {},
      deadLetter: async () => {},
    };
    const alwaysTrue: TurnstileVerifier = async () => true;

    const app = Fastify({ logger: false });
    registerRequestsRoute(app, {
      db: fakeDbReturningNoRow(),
      queue,
      verifyTurnstile: alwaysTrue,
      publicWebOrigin: "https://example.test",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orgs/bright-smile-dental/requests",
      payload: { subject: "s", body: "b", "cf-turnstile-response": "token" },
    });

    expect(res.statusCode).toBe(500);
    // The property that matters: no 201, no tracking token, and above all
    // nothing enqueued pointing at a request row that was never created.
    expect(sent).toEqual([]);
  });
});
