import type { Db } from "@frontdesk/db";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { REQUEST_ID_HEADER, genReqId } from "../logging.js";
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

// ADR-0038 §4. The bridge line is the only record carrying both the HTTP-hop
// id (pino's reqId) and the requests-row id, so it is the single point where
// api-side logs can be joined to worker-side ones. A comment asserting that
// is not a test: this captures pino's actual output and reads the fields back.
describe("the enqueue bridge log line", () => {
  it("logs org_id, request_id and source under the request's reqId", async () => {
    const requestId = "22222222-2222-2222-2222-222222222222";
    const tx = {
      execute: vi.fn().mockResolvedValue({ rows: [] }),
      insert: () => ({ values: () => ({ returning: async () => [{ id: requestId }] }) }),
    };
    const db = {
      select: () => ({ from: () => ({ where: async () => [org] }) }),
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    } as unknown as Db;

    const queue: Queue<TriageMessage> = {
      send: async () => "msg-1",
      receive: async () => [],
      ack: async () => {},
      nack: async () => {},
      deadLetter: async () => {},
    };

    // Capture pino's real output rather than stubbing the logger, so this
    // fails if the call is removed, renamed, or its fields change shape.
    const lines: Record<string, unknown>[] = [];
    const stream = {
      write: (chunk: string) => {
        lines.push(JSON.parse(chunk));
      },
    };

    const app = Fastify({
      logger: { stream },
      genReqId,
    });
    registerRequestsRoute(app, {
      db,
      queue,
      verifyTurnstile: (async () => true) as TurnstileVerifier,
      publicWebOrigin: "https://example.test",
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/orgs/bright-smile-dental/requests",
      headers: { [REQUEST_ID_HEADER]: "edge-trace-1" },
      payload: { subject: "s", body: "b", "cf-turnstile-response": "token" },
    });
    await app.close();

    expect(res.statusCode).toBe(201);

    const bridge = lines.find((l) => l.msg === "request enqueued for triage");
    expect(bridge, "no bridge line was logged").toBeDefined();
    expect(bridge).toMatchObject({
      org_id: org.id,
      request_id: requestId,
      source: "form",
      // The join key on the api side: without reqId on this record the line
      // correlates to nothing upstream of the queue.
      reqId: "edge-trace-1",
    });
  });
});
