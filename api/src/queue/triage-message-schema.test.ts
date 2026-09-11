import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { triageMessageSchema } from "./index.js";

// docs/contracts/triage-message.schema.json is generated from triageMessageSchema,
// not hand-written (#23) - worker/ validates against that committed file directly.
// If this drifts, worker/ and api/ silently disagree on the wire shape and the
// queue has no RLS to catch the mistake. Regenerate with the same z.toJSONSchema()
// call used here whenever triageMessageSchema changes.
const contractPath = fileURLToPath(
  new URL("../../../docs/contracts/triage-message.schema.json", import.meta.url),
);

describe("docs/contracts/triage-message.schema.json", () => {
  it("matches a fresh z.toJSONSchema(triageMessageSchema) regeneration", () => {
    const committed = readFileSync(contractPath, "utf8");
    const fresh = JSON.stringify(z.toJSONSchema(triageMessageSchema), null, 2) + "\n";
    expect(committed).toBe(fresh);
  });
});
