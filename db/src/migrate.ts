import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { logger } from "./logger.js";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");

// The hook Job (#21 PR C) starts as soon as its Pod is scheduled, which
// can be before the Postgres StatefulSet's pod is Ready - retry the
// initial connection rather than fail fast.
async function waitForDatabase(connectionString: string, attempts = 30, delayMs = 2000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = new pg.Client({ connectionString });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      logger.info("database reachable", { attempt });
      return;
    } catch (err) {
      await client.end().catch(() => {});
      if (attempt === attempts) {
        throw err;
      }
      logger.info("database not ready, retrying", {
        attempt,
        attempts,
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function main(): Promise<void> {
  const url = process.env.MIGRATE_DATABASE_URL;
  if (!url) {
    throw new Error("MIGRATE_DATABASE_URL is required (see .env.example)");
  }

  await waitForDatabase(url);

  const pool = new pg.Pool({ connectionString: url });
  const db = drizzle(pool);

  logger.info("running migrations", { migrationsFolder });
  await migrate(db, { migrationsFolder });
  logger.info("migrations complete");

  await pool.end();
}

main().catch((err: unknown) => {
  logger.error("migration failed", { error: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
});
