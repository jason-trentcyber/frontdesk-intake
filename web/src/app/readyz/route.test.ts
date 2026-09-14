import { createDb } from "@frontdesk/db";
import { describe, expect, it, vi } from "vitest";

const appUrl = process.env.DATABASE_APP_URL ?? process.env.DATABASE_URL;

describe("GET /readyz", () => {
  it.skipIf(!appUrl)("returns 200 when the database is reachable", async () => {
    vi.resetModules();
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  // A deliberately bad connection, not a mutated process.env: getDb()'s
  // singleton is keyed on globalThis and would otherwise leak whichever
  // Db this test built into every other test that calls getDb() in the
  // same process.
  it("returns 503 with a generic body when the database is unreachable - no live DB needed for this one", async () => {
    vi.resetModules();
    vi.doMock("../../lib/db", () => ({
      getDb: () => createDb("postgresql://nobody:wrong@localhost:1/nonexistent"),
    }));
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string };
    expect(body).toEqual({ status: "not ready" });
    expect(JSON.stringify(body)).not.toContain("postgresql://");
  });
});
