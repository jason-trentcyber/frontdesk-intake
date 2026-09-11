import { describe, expect, it } from "vitest";
import { assertTriageMessage } from "./index.js";

// The queue has no RLS (pgmq q_*/a_* tables, rowsecurity = f), so this
// assertion is the only thing standing between a refactor that forgets
// orgId and an unscoped message sitting durably in the queue.
describe("assertTriageMessage", () => {
  it("accepts a complete message", () => {
    expect(() => assertTriageMessage({ orgId: "org-1", requestId: "req-1" })).not.toThrow();
  });

  it.each([
    ["missing orgId", { requestId: "req-1" }],
    ["empty orgId", { orgId: "", requestId: "req-1" }],
    ["orgId not a string", { orgId: 42, requestId: "req-1" }],
  ])("rejects %s, naming the RLS gap", (_label, value) => {
    expect(() => assertTriageMessage(value)).toThrow(/orgId is required.*no RLS/);
  });

  it.each([
    ["missing requestId", { orgId: "org-1" }],
    ["empty requestId", { orgId: "org-1", requestId: "" }],
  ])("rejects %s", (_label, value) => {
    expect(() => assertTriageMessage(value)).toThrow(/requestId is required/);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(() => assertTriageMessage(value)).toThrow(/orgId is required/);
  });

  // .strict(): without it, an extra property is silently stripped and the
  // (now-narrower) object reaches queue.send() - but assertTriageMessage
  // asserts on the *original* value, so a hand-shaped or version-skewed
  // payload with an extra key would go out unmodified with no error at all.
  it("rejects a message with an extra property", () => {
    const value = { orgId: "org-1", requestId: "req-1", extra: "nope" };
    expect(() => assertTriageMessage(value)).toThrow(/unrecognized properties/);
  });
});
