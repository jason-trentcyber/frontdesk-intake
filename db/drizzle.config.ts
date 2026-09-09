import { defineConfig } from "drizzle-kit";

const url = process.env.MIGRATE_DATABASE_URL;
if (!url) {
  throw new Error("MIGRATE_DATABASE_URL is required (see .env.example)");
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
