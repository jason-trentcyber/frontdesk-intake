import type { Db } from "@frontdesk/db";
import type { Env } from "../env.js";
import type { Queue, TriageMessage } from "./index.js";
import { PostgresQueue } from "./pgmq.js";
import { SqsQueue } from "./sqs.js";

// Selection by QUEUE_PROVIDER only - no auto-detection, no other switch
// (ADR-0004).
export function createQueue(env: Env, db: Db): Queue<TriageMessage> {
  if (env.QUEUE_PROVIDER === "pgmq") {
    return new PostgresQueue<TriageMessage>(db);
  }
  if (env.QUEUE_PROVIDER === "sqs") {
    if (!env.SQS_QUEUE_URL || !env.SQS_DLQ_URL || !env.AWS_REGION) {
      throw new Error("SQS_QUEUE_URL, SQS_DLQ_URL, and AWS_REGION are required when QUEUE_PROVIDER=sqs");
    }
    return new SqsQueue<TriageMessage>({
      queueUrl: env.SQS_QUEUE_URL,
      dlqUrl: env.SQS_DLQ_URL,
      region: env.AWS_REGION,
      endpoint: env.AWS_ENDPOINT_URL,
    });
  }
  // Exhaustive per env.ts's z.enum(["pgmq", "sqs"]) - unreachable in
  // practice, but satisfies TypeScript in the general case.
  throw new Error(`Unknown QUEUE_PROVIDER: ${env.QUEUE_PROVIDER as string}`);
}
