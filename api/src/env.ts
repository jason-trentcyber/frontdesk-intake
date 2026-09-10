import { z } from "zod";

const rawEnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  // Production (the chart's api-deployment.yaml, ADR-0017/0021) sets
  // only DATABASE_URL, built by Kubernetes $(VAR) expansion from the
  // frontdesk_app role - ADR-0021 states explicitly that
  // DATABASE_APP_URL has "no in-cluster counterpart". Locally,
  // .env.example's DATABASE_URL is the *owner* role (for db/'s
  // migrate/seed) and DATABASE_APP_URL is the runtime role - api/ must
  // never run as the owner role, so loadEnv() below prefers
  // DATABASE_APP_URL when present and falls back to DATABASE_URL, which
  // resolves correctly in both places: locally to the app role
  // (DATABASE_APP_URL is set), in the cluster to the app role too (it's
  // the only one set there).
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_APP_URL: z.string().min(1).optional(),
  QUEUE_PROVIDER: z.enum(["pgmq", "sqs"]),
  // Absent locally unless testing the Turnstile path by hand; required
  // in the cluster (secretKeyRef on the turnstile SealedSecret).
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // Not in the brief; needed to build an absolute trackingUrl a
  // third-party integration can hand to its own users (CLAUDE.md's
  // "Site: https://frontdesk.jtrent.dev").
  PUBLIC_WEB_ORIGIN: z.string().default("https://frontdesk.jtrent.dev"),
  // SQS adapter only.
  AWS_ENDPOINT_URL: z.string().optional(),
  AWS_REGION: z.string().optional(),
  SQS_QUEUE_URL: z.string().optional(),
  SQS_DLQ_URL: z.string().optional(),
});

export type Env = z.infer<typeof rawEnvSchema> & { databaseUrl: string };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = rawEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;

  const databaseUrl = env.DATABASE_APP_URL ?? env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL (or DATABASE_APP_URL locally) is required");
  }

  if (env.QUEUE_PROVIDER === "sqs") {
    for (const key of ["AWS_REGION", "SQS_QUEUE_URL", "SQS_DLQ_URL"] as const) {
      if (!env[key]) {
        throw new Error(`${key} is required when QUEUE_PROVIDER=sqs`);
      }
    }
  }

  return { ...env, databaseUrl };
}
