import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ingestMessageSchema } from "./index.js";

// docs/contracts/ingest-message.schema.json is generated from
// ingestMessageSchema, not hand-written (ADR-0025 §1, mirroring #23's
// triage-message-schema.test.ts exactly) - worker/ validates against that
// committed file directly. If this drifts, worker/ and api/ silently
// disagree on the wire shape and the queue has no RLS to catch the mistake.
const contractPath = fileURLToPath(
  new URL("../../../docs/contracts/ingest-message.schema.json", import.meta.url),
);

describe("docs/contracts/ingest-message.schema.json", () => {
  it("matches a fresh z.toJSONSchema(ingestMessageSchema) regeneration", () => {
    const committed = readFileSync(contractPath, "utf8");
    const fresh = JSON.stringify(z.toJSONSchema(ingestMessageSchema), null, 2) + "\n";
    expect(committed).toBe(fresh);
  });
});
