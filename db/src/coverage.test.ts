import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { NON_TENANT_TABLES } from "./client.js";
import * as schema from "./schema/index.js";

// Replaces the #21 issue's "middleware coverage test" (ADR-0018): every
// exported table not on the NON_TENANT_TABLES allow-list must carry
// org_id, RLS, and a policy in the same schema file it's defined in.
const tables = (Object.values(schema) as unknown[]).filter((value): value is PgTable =>
  is(value, PgTable),
);

describe("tenant table coverage (ADR-0018)", () => {
  it("found tables to check", () => {
    expect(tables.length).toBeGreaterThan(0);
  });

  it("NON_TENANT_TABLES is exactly the documented allow-list", () => {
    // Deliberately NOT widened to include the auth.* tables (ADR-0031):
    // this allow-list's whole value is being short. The auth schema is
    // a second, separately-asserted exemption below, not folded into
    // this one - see "auth schema coverage" below.
    expect(NON_TENANT_TABLES).toEqual(["orgs"]);
  });

  for (const table of tables) {
    const config = getTableConfig(table);
    if (config.schema === "auth") {
      continue; // covered by its own describe block below, not this loop.
    }
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

// ADR-0031: Auth.js's own tables (auth.users/accounts/sessions/
// verification_tokens) are not tenant data - no org_id, no RLS, no
// policy - and live in a dedicated `auth` Postgres schema specifically
// so this is a structural fact (config.schema === "auth"), not a name a
// contributor has to remember to add to NON_TENANT_TABLES. Both
// directions are asserted: every auth.* table has no org_id, and no
// table outside auth (and not `orgs`) is missing one - so a table
// silently added to the wrong side of that line fails one assertion or
// the other.
describe("auth schema coverage (ADR-0031, amends ADR-0018)", () => {
  const authTables = tables.filter((table) => getTableConfig(table).schema === "auth");
  const nonAuthTenantTables = tables.filter((table) => {
    const config = getTableConfig(table);
    return (
      config.schema !== "auth" && !(NON_TENANT_TABLES as readonly string[]).includes(config.name)
    );
  });

  it("found at least one auth.* table", () => {
    expect(authTables.length).toBeGreaterThan(0);
  });

  it("no table in the auth schema has an org_id column", () => {
    for (const table of authTables) {
      const config = getTableConfig(table);
      expect(
        config.columns.some((c) => c.name === "org_id"),
        `auth.${config.name} must not have org_id`,
      ).toBe(false);
    }
  });

  it("no table outside the auth schema (and not orgs) lacks an org_id column", () => {
    for (const table of nonAuthTenantTables) {
      const config = getTableConfig(table);
      expect(
        config.columns.some((c) => c.name === "org_id"),
        `${config.name} is missing org_id`,
      ).toBe(true);
    }
  });
});
