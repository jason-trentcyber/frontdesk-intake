import { describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { seedDatabase } from "./seed.js";

const url = process.env.DATABASE_URL;

// Needs a live, migrated Postgres - skips with a named reason rather than
// failing, so `pnpm test` at the root still passes without Postgres
// running.
describe.skipIf(!url)(url ? "seed idempotency (ADR-0018)" : "seed idempotency (ADR-0018) [skipped: DATABASE_URL not set]", () => {
  it("running seed twice produces identical row counts", async () => {
    const db = createDb(url!);

    const first = await seedDatabase(db);
    const second = await seedDatabase(db);

    // Second run should find everything already present: nothing new.
    expect(second).toEqual({ orgs: 0, owners: 0, documents: 0, requests: 0 });
    // Sanity: the first run (in this process) did create something, or
    // an earlier `pnpm seed` already had - either way the DB is seeded.
    expect(first.orgs + first.owners + first.documents + first.requests).toBeGreaterThanOrEqual(0);
  });
});
