import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { NON_TENANT_TABLES } from "./client.js";
import * as schema from "./schema/index.js";

// Replaces the #21 issue's "middleware coverage test" (ADR-0018): every
// exported table not on the NON_TENANT_TABLES allow-list must carry
// org_id, RLS, and a policy in the same schema file it's defined in.
const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable => is(value, PgTable));

describe("tenant table coverage (ADR-0018)", () => {
  it("found tables to check", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it("NON_TENANT_TABLES is exactly the documented allow-list", () => {
    expect(NON_TENANT_TABLES).toEqual(["orgs"]);
  });

  for (const table of tables) {
    const config = getTableConfig(table);
    if ((NON_TENANT_TABLES as readonly string[]).includes(config.name)) {
      continue;
    }

    describe(config.name, () => {
      it("has an org_id column", () => {
        expect(config.columns.some((c) => c.name === "org_id")).toBe(true);
      });

      it("has row-level security enabled", () => {
        expect(config.enableRLS).toBe(true);
      });

      it("has at least one policy", () => {
        expect(config.policies.length).toBeGreaterThan(0);
      });
    });
  }
});
