import { describe, expect, it } from "vitest";
import { SqsQueue } from "./sqs.js";

// The contract test covers both adapters' happy paths against real
// services. This covers SqsQueue's one defensive branch, which by
// definition cannot be reached through the Queue interface used correctly:
// deadLetter() needs the message body, and SQS can only give it back at
// receive() time (pgmq's archive() needs only the id - the one place the
// two backends genuinely differ, see the class comment).
describe("SqsQueue.deadLetter with an unknown id", () => {
  it("throws rather than silently dropping the message", async () => {
    // No network: the client is constructed but never reached, because
    // the cache lookup fails first.
    const queue = new SqsQueue<{ hello: string }>({
      queueUrl: "http://localhost:1/main",
      dlqUrl: "http://localhost:1/dlq",
      region: "us-east-1",
    });
    await expect(queue.deadLetter("never-received")).rejects.toThrow(
      /no cached body - id must come from receive/,
    );
  });
});
