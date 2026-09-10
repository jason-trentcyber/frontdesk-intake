import { createHash } from "node:crypto";

// F3: the key itself is shown once and never stored - only this hash is
// (db/src/schema/api-keys.ts's key_hash column; resolveApiKey looks up by
// this same hash).
//
// Unsalted SHA-256 is deliberate, not an oversight, and is NOT the right
// choice for passwords. A stretched, salted KDF (bcrypt/argon2) exists to
// make guessing a low-entropy human-chosen secret expensive. An API key
// here is 256 bits of CSPRNG output: there is nothing to guess, no
// dictionary to run, and no reuse across sites to protect. Salting would
// also break the lookup - resolveApiKey finds the row BY the hash, and a
// per-row salt would force a scan-and-compare over every key. Same
// reasoning GitHub and Stripe apply to their token hashes.
export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}
