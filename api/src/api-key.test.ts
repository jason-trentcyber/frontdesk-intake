import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "./api-key.js";

// Fixtures are deliberately not key-shaped. A realistic-looking literal
// ("fd_live_...") trips gitleaks' generic-api-key rule, and the right
// answer is a fixture that isn't a plausible credential - not an
// allowlist entry that would also cover a real leak in this file.
describe("hashApiKey", () => {
  it("is hex-encoded SHA-256 of the utf8 input", () => {
    const input = "example input one";
    expect(hashApiKey(input)).toBe(createHash("sha256").update(input, "utf8").digest("hex"));
    expect(hashApiKey(input)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic - resolveApiKey looks the row up BY this hash", () => {
    expect(hashApiKey("example input one")).toBe(hashApiKey("example input one"));
  });

  it("differs for inputs differing by one character", () => {
    expect(hashApiKey("example input a")).not.toBe(hashApiKey("example input b"));
  });
});
