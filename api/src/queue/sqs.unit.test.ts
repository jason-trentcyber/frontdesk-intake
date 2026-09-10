import { describe, expect, it, vi } from "vitest";
import { SqsQueue } from "./sqs.js";

// The contract test covers both adapters' happy paths against real
// services. This file covers SqsQueue's defensive branches - the ones a
// working SQS never reaches, which is exactly why they need a stubbed
// client rather than LocalStack. Parity with pgmq.unit.test.ts.
function queueWithClient(send: unknown): SqsQueue<{ hello: string }> {
  const queue = new SqsQueue<{ hello: string }>({
    queueUrl: "http://localhost:1/main",
    dlqUrl: "http://localhost:1/dlq",
    region: "us-east-1",
  });
  // Replace the constructed client: no network in this file.
  (queue as unknown as { client: { send: unknown } }).client = { send };
  return queue;
}

describe("SqsQueue defensive branches", () => {
  it("send() throws when SQS returns no MessageId", async () => {
    const queue = queueWithClient(vi.fn().mockResolvedValue({}));
    await expect(queue.send({ hello: "x" })).rejects.toThrow(/returned no MessageId/);
  });

  it("receive() throws when a message has no ReceiptHandle", async () => {
    const queue = queueWithClient(
      vi.fn().mockResolvedValue({ Messages: [{ Body: '{"hello":"x"}' }] }),
    );
    await expect(queue.receive(30)).rejects.toThrow(/missing ReceiptHandle or Body/);
  });

  it("receive() throws when a message has no Body", async () => {
    const queue = queueWithClient(
      vi.fn().mockResolvedValue({ Messages: [{ ReceiptHandle: "rh" }] }),
    );
    await expect(queue.receive(30)).rejects.toThrow(/missing ReceiptHandle or Body/);
  });

  it("receive() returns an empty array when SQS returns no Messages key at all", async () => {
    const queue = queueWithClient(vi.fn().mockResolvedValue({}));
    await expect(queue.receive(30)).resolves.toEqual([]);
  });

  it("deadLetter() with an id receive() never returned throws rather than dropping the message", async () => {
    // The cache lookup fails before the client is touched.
    const queue = queueWithClient(vi.fn());
    await expect(queue.deadLetter("never-received")).rejects.toThrow(
      /no cached body - id must come from receive/,
    );
  });
});
