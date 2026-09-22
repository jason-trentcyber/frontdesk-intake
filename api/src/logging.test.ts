import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { type AppDeps, buildApp } from "./app.js";
import {
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADER,
  genReqId,
  sanitizeRequestId,
} from "./logging.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("sanitizeRequestId", () => {
  it.each([
    ["a uuid", "f81d4fae-7dec-11d0-a765-00a0c91e6bf6"],
    ["a cloudflare ray id", "8a1b2c3d4e5f6a7b-ORD"],
    ["a w3c trace-id", "4bf92f3577b34da6a3ce929d0e0e4736"],
    ["dots and underscores", "svc.web_1:2"],
    ["a single character", "x"],
    ["exactly the length cap", "a".repeat(MAX_REQUEST_ID_LENGTH)],
  ])("accepts %s", (_label, value) => {
    expect(sanitizeRequestId(value)).toBe(value);
  });

  it("trims surrounding whitespace and returns the trimmed value", () => {
    expect(sanitizeRequestId("  req-abc  ")).toBe("req-abc");
  });

  it.each([
    ["a duplicated header (array)", ["a", "b"]],
    ["undefined (header absent)", undefined],
    ["a number", 42],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "   "],
    ["one over the length cap", "a".repeat(MAX_REQUEST_ID_LENGTH + 1)],
    ["a newline (log forging)", "abc\ndef"],
    ["a carriage return", "abc\r\ndef"],
    ["a space in the middle", "abc def"],
    ["a quote", 'abc"def'],
    ["a brace", "{abc}"],
    ["non-ascii", "abc\u00e9"],
    ["a null byte", "abc\u0000def"],
  ])("rejects %s", (_label, value) => {
    expect(sanitizeRequestId(value)).toBeNull();
  });
});

describe("genReqId", () => {
  it("honours a valid inbound header", () => {
    const id = genReqId({ headers: { [REQUEST_ID_HEADER]: "edge-abc123" } });
    expect(id).toBe("edge-abc123");
  });

  it("generates a uuid when the header is absent", () => {
    expect(genReqId({ headers: {} })).toMatch(UUID_RE);
  });

  it("generates a uuid rather than propagating a rejected header", () => {
    const id = genReqId({ headers: { [REQUEST_ID_HEADER]: "bad value\nwith newline" } });
    expect(id).toMatch(UUID_RE);
  });

  it("returns a different id on each call when generating", () => {
    expect(genReqId({ headers: {} })).not.toBe(genReqId({ headers: {} }));
  });
});

// The wiring, not just the function: a unit test on genReqId passes whether
// or not buildApp actually tells Fastify to call it. These go through the
// real buildApp and read the id Fastify assigned.
describe("buildApp wiring", () => {
  // buildApp registers every route, but /healthz touches none of these -
  // stubs are enough to construct the app and probe req.id.
  const stubDeps = {
    db: {} as AppDeps["db"],
    queue: {} as AppDeps["queue"],
    verifyTurnstile: (async () => true) as AppDeps["verifyTurnstile"],
    publicWebOrigin: "https://example.test",
  };

  async function reqId(headers: Record<string, string> = {}): Promise<string> {
    const app = buildApp(stubDeps);
    // A route that echoes the id Fastify assigned. Added to the built app
    // so the id comes from buildApp's own genReqId configuration.
    app.get("/__req_id", async (req) => ({ id: req.id }));
    const res = await app.inject({ method: "GET", url: "/__req_id", headers });
    await app.close();
    return JSON.parse(res.payload).id as string;
  }

  it("uses the sanitized inbound id as req.id", async () => {
    expect(await reqId({ [REQUEST_ID_HEADER]: "edge-abc123" })).toBe("edge-abc123");
  });

  it("does not emit pino's req-N counter ids", async () => {
    const id = await reqId();
    expect(id).toMatch(UUID_RE);
    expect(id).not.toMatch(/^req-/);
  });

  it("generates a uuid rather than propagating a rejected header", async () => {
    expect(await reqId({ [REQUEST_ID_HEADER]: "forged\ninjected" })).toMatch(UUID_RE);
  });

  it("gives two header-less requests distinct ids", async () => {
    expect(await reqId()).not.toBe(await reqId());
  });

  // Regression guard for the trap documented in app.ts. Fastify's
  // reqIdGenFactory returns `req.headers[requestIdHeader] || genReqId(req)`,
  // so setting requestIdHeader makes the RAW header win and sanitizeRequestId
  // never runs. Demonstrated here on a bare Fastify so the vulnerable
  // behaviour is stated explicitly: adding `requestIdHeader` to buildApp
  // becomes a visible contradiction of this test, not a silent regression.
  it("would bypass sanitization if requestIdHeader were set (why buildApp omits it)", async () => {
    const app = Fastify({ logger: false, genReqId, requestIdHeader: REQUEST_ID_HEADER });
    app.get("/probe", async (req) => ({ id: req.id }));
    const forged = "forged\ninjected-line";
    const res = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { [REQUEST_ID_HEADER]: forged },
    });
    expect(JSON.parse(res.payload).id).toBe(forged);
    await app.close();
  });
});
