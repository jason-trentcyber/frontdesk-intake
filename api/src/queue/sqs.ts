import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Queue, QueueMessage } from "./index.js";

// AGENTS.md's openrouter/bedrock/boto3 rule, same principle: this is the
// only file that may import @aws-sdk/*.

export interface SqsQueueConfig {
  queueUrl: string;
  dlqUrl: string;
  region: string;
  endpoint?: string;
}

export class SqsQueue<T> implements Queue<T> {
  private readonly client: SQSClient;
  private readonly queueUrl: string;
  private readonly dlqUrl: string;

  // SQS's ack/nack take a receipt handle, not a stable message id, and a
  // receipt handle alone can't be used to fetch the body back later - but
  // deadLetter needs the body to copy it to the DLQ (LocalStack will not
  // enforce a redrive policy for us). Cache it from receive(), keyed by
  // the same id handed back as QueueMessage.id; evicted on ack/deadLetter.
  // pgmq needs no equivalent - archive() only needs the id. This is the
  // one real impedance mismatch this interface papers over between the
  // two backends.
  private readonly received = new Map<string, T>();

  constructor(config: SqsQueueConfig) {
    this.client = new SQSClient({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    });
    this.queueUrl = config.queueUrl;
    this.dlqUrl = config.dlqUrl;
  }

  async send(payload: T): Promise<string> {
    const result = await this.client.send(
      new SendMessageCommand({ QueueUrl: this.queueUrl, MessageBody: JSON.stringify(payload) }),
    );
    if (!result.MessageId) {
      throw new Error("SendMessageCommand returned no MessageId");
    }
    return result.MessageId;
  }

  async receive(visibilityTimeout: number, qty = 1): Promise<QueueMessage<T>[]> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        VisibilityTimeout: visibilityTimeout,
        MaxNumberOfMessages: Math.min(qty, 10), // hard SQS API ceiling
      }),
    );
    const messages = result.Messages ?? [];
    return messages.map((m) => {
      if (!m.ReceiptHandle || m.Body === undefined) {
        throw new Error("SQS message missing ReceiptHandle or Body");
      }
      const body = JSON.parse(m.Body) as T;
      this.received.set(m.ReceiptHandle, body);
      return { id: m.ReceiptHandle, body };
    });
  }

  async ack(id: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: id }));
    this.received.delete(id);
  }

  async nack(id: string): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({ QueueUrl: this.queueUrl, ReceiptHandle: id, VisibilityTimeout: 0 }),
    );
    // Left in the cache: a caller may legitimately deadLetter this id
    // without an intervening receive().
  }

  async deadLetter(id: string): Promise<void> {
    const body = this.received.get(id);
    if (body === undefined) {
      throw new Error(`deadLetter(${id}): no cached body - id must come from receive() on this adapter instance`);
    }
    await this.client.send(new SendMessageCommand({ QueueUrl: this.dlqUrl, MessageBody: JSON.stringify(body) }));
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: id }));
    this.received.delete(id);
  }
}
