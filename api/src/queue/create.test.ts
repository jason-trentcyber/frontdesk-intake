import { describe, expect, it } from "vitest";
import type { Db } from "@frontdesk/db";
import type { Env } from "../env.js";
import { createIngestQueue, createQueue } from "./create.js";
import { PostgresQueue } from "./pgmq.js";
import { SqsQueue } from "./sqs.js";

// createQueue never touches the db handle - it only stores it on
// PostgresQueue - so a bare object is enough to exercise every branch
// without a database.
const db = {} as Db;

function env(overrides: Partial<Env>): Env {
  return {
    PORT: 3001,
    QUEUE_PROVIDER: "pgmq",
    PUBLIC_WEB_ORIGIN: "https://example.test",
    databaseUrl: "postgresql://user@localhost:5432/frontdesk",
    ...overrides,
  } as Env;
}

describe("createQueue", () => {
  it("returns a PostgresQueue for QUEUE_PROVIDER=pgmq", () => {
    expect(createQueue(env({ QUEUE_PROVIDER: "pgmq" }), db)).toBeInstanceOf(PostgresQueue);
  });

  it("returns an SqsQueue for QUEUE_PROVIDER=sqs with complete config", () => {
    const queue = createQueue(
      env({
        QUEUE_PROVIDER: "sqs",
        AWS_REGION: "us-east-1",
        SQS_QUEUE_URL: "http://localhost:4566/000000000000/frontdesk-triage",
        SQS_DLQ_URL: "http://localhost:4566/000000000000/frontdesk-triage-dlq",
      }),
      db,
    );
    expect(queue).toBeInstanceOf(SqsQueue);
  });

  // loadEnv() validates these too, but createQueue is exported and
  // callable on its own, so its own guard has to hold - each field
  // missing independently.
  it.each(["AWS_REGION", "SQS_QUEUE_URL", "SQS_DLQ_URL"] as const)(
    "throws for QUEUE_PROVIDER=sqs when %s is missing",
    (missing) => {
      const complete = {
        QUEUE_PROVIDER: "sqs" as const,
        AWS_REGION: "us-east-1",
        SQS_QUEUE_URL: "http://localhost:4566/000000000000/frontdesk-triage",
        SQS_DLQ_URL: "http://localhost:4566/000000000000/frontdesk-triage-dlq",
      };
      expect(() => createQueue(env({ ...complete, [missing]: undefined }), db)).toThrow(
        /SQS_QUEUE_URL, SQS_DLQ_URL, and AWS_REGION are required/,
      );
    },
  );

  it("throws for an unknown provider", () => {
    expect(() => createQueue(env({ QUEUE_PROVIDER: "rabbitmq" as never }), db)).toThrow(
      /Unknown QUEUE_PROVIDER/,
    );
  });
});

// Same branches, the ingest queue (ADR-0025 §1) - its own name under pgmq,
// its own URL pair under sqs, since two logical queues can't share one SQS
// URL.
describe("createIngestQueue", () => {
  it("returns a PostgresQueue for QUEUE_PROVIDER=pgmq", () => {
    expect(createIngestQueue(env({ QUEUE_PROVIDER: "pgmq" }), db)).toBeInstanceOf(PostgresQueue);
  });

  it("returns an SqsQueue for QUEUE_PROVIDER=sqs with complete config", () => {
    const queue = createIngestQueue(
      env({
        QUEUE_PROVIDER: "sqs",
        AWS_REGION: "us-east-1",
        INGEST_SQS_QUEUE_URL: "http://localhost:4566/000000000000/frontdesk-ingest",
        INGEST_SQS_DLQ_URL: "http://localhost:4566/000000000000/frontdesk-ingest-dlq",
      }),
      db,
    );
    expect(queue).toBeInstanceOf(SqsQueue);
  });

  it.each(["AWS_REGION", "INGEST_SQS_QUEUE_URL", "INGEST_SQS_DLQ_URL"] as const)(
    "throws for QUEUE_PROVIDER=sqs when %s is missing",
    (missing) => {
      const complete = {
        QUEUE_PROVIDER: "sqs" as const,
        AWS_REGION: "us-east-1",
        INGEST_SQS_QUEUE_URL: "http://localhost:4566/000000000000/frontdesk-ingest",
        INGEST_SQS_DLQ_URL: "http://localhost:4566/000000000000/frontdesk-ingest-dlq",
      };
      expect(() => createIngestQueue(env({ ...complete, [missing]: undefined }), db)).toThrow(
        /SQS_QUEUE_URL, SQS_DLQ_URL, and AWS_REGION are required/,
      );
    },
  );

  it("throws for an unknown provider", () => {
    expect(() => createIngestQueue(env({ QUEUE_PROVIDER: "rabbitmq" as never }), db)).toThrow(
      /Unknown QUEUE_PROVIDER/,
    );
  });
});
