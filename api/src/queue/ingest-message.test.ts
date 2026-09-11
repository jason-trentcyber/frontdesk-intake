import { describe, expect, it } from "vitest";
import { assertIngestMessage } from "./index.js";

// Mirrors triage-message.test.ts exactly - assertIngestMessage is the same
// shape of guard on the same class of RLS-less queue (ADR-0025 §1).
describe("assertIngestMessage", () => {
  it("accepts a complete message", () => {
    expect(() => assertIngestMessage({ orgId: "org-1", documentId: "doc-1" })).not.toThrow();
  });

  it.each([
    ["missing orgId", { documentId: "doc-1" }],
    ["empty orgId", { orgId: "", documentId: "doc-1" }],
    ["orgId not a string", { orgId: 42, documentId: "doc-1" }],
  ])("rejects %s, naming the RLS gap", (_label, value) => {
    expect(() => assertIngestMessage(value)).toThrow(/orgId is required.*no RLS/);
  });

  it.each([
    ["missing documentId", { orgId: "org-1" }],
    ["empty documentId", { orgId: "org-1", documentId: "" }],
  ])("rejects %s", (_label, value) => {
    expect(() => assertIngestMessage(value)).toThrow(/documentId is required/);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(() => assertIngestMessage(value)).toThrow(/orgId is required/);
  });

  it("rejects a message with an extra property", () => {
    const value = { orgId: "org-1", documentId: "doc-1", extra: "nope" };
    expect(() => assertIngestMessage(value)).toThrow(/unrecognized properties/);
  });
});
