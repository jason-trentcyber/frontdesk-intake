import type { Db } from "@frontdesk/db";
import type { Env } from "../env.js";
import {
  INGEST_QUEUE_NAME,
  QUEUE_NAME,
  type IngestMessage,
  type Queue,
  type TriageMessage,
} from "./index.js";
import { PostgresQueue } from "./pgmq.js";
import { SqsQueue } from "./sqs.js";

// Selection by QUEUE_PROVIDER only - no auto-detection, no other switch
// (ADR-0004). Shared by createQueue and createIngestQueue below: the two
// queues differ only in name and (under sqs) which URL pair backs them -
// everything else about "how to build a Queue for this provider" is
// identical, so it lives once here rather than twice.
function createQueueFor<T>(
  env: Env,
  db: Db,
  opts: { pgmqName: string; sqsQueueUrl: string | undefined; sqsDlqUrl: string | undefined },
): Queue<T> {
  if (env.QUEUE_PROVIDER === "pgmq") {
    return new PostgresQueue<T>(db, opts.pgmqName);
  }
  if (env.QUEUE_PROVIDER === "sqs") {
    if (!opts.sqsQueueUrl || !opts.sqsDlqUrl || !env.AWS_REGION) {
      throw new Error(
        "SQS_QUEUE_URL, SQS_DLQ_URL, and AWS_REGION are required when QUEUE_PROVIDER=sqs",
      );
    }
    return new SqsQueue<T>({
      queueUrl: opts.sqsQueueUrl,
      dlqUrl: opts.sqsDlqUrl,
      region: env.AWS_REGION,
      endpoint: env.AWS_ENDPOINT_URL,
    });
  }
  // Exhaustive per env.ts's z.enum(["pgmq", "sqs"]) - unreachable in
  // practice, but satisfies TypeScript in the general case.
  throw new Error(`Unknown QUEUE_PROVIDER: ${env.QUEUE_PROVIDER as string}`);
}

export function createQueue(env: Env, db: Db): Queue<TriageMessage> {
  return createQueueFor<TriageMessage>(env, db, {
    pgmqName: QUEUE_NAME,
    sqsQueueUrl: env.SQS_QUEUE_URL,
    sqsDlqUrl: env.SQS_DLQ_URL,
  });
}

// ADR-0025 §1: the ingestion trigger queue. Error text intentionally says
// "SQS_QUEUE_URL, SQS_DLQ_URL" (not the INGEST_ prefixed names) because
// that is the generic message createQueueFor always throws - loadEnv()'s
// own check (env.ts) is what names the INGEST_-prefixed keys specifically
// when they're the ones missing.
export function createIngestQueue(env: Env, db: Db): Queue<IngestMessage> {
  return createQueueFor<IngestMessage>(env, db, {
    pgmqName: INGEST_QUEUE_NAME,
    sqsQueueUrl: env.INGEST_SQS_QUEUE_URL,
    sqsDlqUrl: env.INGEST_SQS_DLQ_URL,
  });
}
