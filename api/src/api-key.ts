import { createHash } from "node:crypto";

// F3: the key itself is shown once and never stored - only this hash is
// (db/src/schema/api-keys.ts's key_hash column; resolveApiKey looks up by
// this same hash).
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
