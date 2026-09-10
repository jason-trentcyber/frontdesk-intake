import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

// loadEnv() decides which database role api/ connects as. Getting the
// fallback backwards would silently run the service as the owner role,
// which RLS does not constrain (ADR-0018) - worth pinning.
const base = { QUEUE_PROVIDER: "pgmq" as const, PUBLIC_WEB_ORIGIN: "https://example.test" };

describe("loadEnv", () => {
  it("prefers DATABASE_APP_URL over DATABASE_URL", () => {
    const env = loadEnv({
      ...base,
      DATABASE_URL: "postgresql://owner@h/db",
      DATABASE_APP_URL: "postgresql://app@h/db",
    });
    expect(env.databaseUrl).toBe("postgresql://app@h/db");
  });

  it("falls back to DATABASE_URL in the cluster, where DATABASE_APP_URL has no counterpart", () => {
    expect(loadEnv({ ...base, DATABASE_URL: "postgresql://app@h/db" }).databaseUrl).toBe(
      "postgresql://app@h/db",
    );
  });

  it("requires PUBLIC_WEB_ORIGIN - no hardcoded production default", () => {
    expect(() => loadEnv({ QUEUE_PROVIDER: "pgmq", DATABASE_URL: "x" })).toThrow(
      /Invalid environment/,
    );
  });

  it("throws when neither database URL is set", () => {
    expect(() => loadEnv({ ...base })).toThrow(/DATABASE_URL/);
  });

  it("defaults PORT to 3001 and coerces a string port", () => {
    expect(loadEnv({ ...base, DATABASE_URL: "x" }).PORT).toBe(3001);
    expect(loadEnv({ ...base, DATABASE_URL: "x", PORT: "8080" }).PORT).toBe(8080);
  });

  it("rejects an unknown QUEUE_PROVIDER", () => {
    expect(() => loadEnv({ QUEUE_PROVIDER: "rabbitmq", DATABASE_URL: "x" })).toThrow(
      /Invalid environment/,
    );
  });

  it.each(["AWS_REGION", "SQS_QUEUE_URL", "SQS_DLQ_URL"])(
    "requires %s when QUEUE_PROVIDER=sqs",
    (missing) => {
      const sqs: Record<string, string> = {
        QUEUE_PROVIDER: "sqs",
        PUBLIC_WEB_ORIGIN: "https://example.test",
        DATABASE_URL: "x",
        AWS_REGION: "us-east-1",
        SQS_QUEUE_URL: "https://sqs/main",
        SQS_DLQ_URL: "https://sqs/dlq",
      };
      delete sqs[missing];
      expect(() => loadEnv(sqs)).toThrow(`${missing} is required when QUEUE_PROVIDER=sqs`);
    },
  );

  it("accepts a complete sqs config", () => {
    const env = loadEnv({
      QUEUE_PROVIDER: "sqs",
      PUBLIC_WEB_ORIGIN: "https://example.test",
      DATABASE_URL: "x",
      AWS_REGION: "us-east-1",
      SQS_QUEUE_URL: "https://sqs/main",
      SQS_DLQ_URL: "https://sqs/dlq",
    });
    expect(env.QUEUE_PROVIDER).toBe("sqs");
  });
});
