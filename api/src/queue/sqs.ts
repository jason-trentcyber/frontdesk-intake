import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import type { Queue, QueueMessage } from "./index.js";

// AGENTS.md's openrouter/bedrock/boto3 rule, same principle: this is the
// only PRODUCTION file that may import @aws-sdk/*. queue.contract.test.ts
// also imports it, to create and drop the LocalStack queues its fixture
// runs against - that is test scaffolding standing in for infrastructure
// (Terraform owns real SQS queues), not the service reaching for a vendor
// SDK behind the Queue interface.

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
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: id }),
    );
    this.received.delete(id);
  }

  // Returns the message to the queue immediately. NOTE: the id (a receipt
  // handle) is not reliably usable afterwards. SQS issues a new receipt
  // handle every time a message is received, and requires the most recent
  // one for DeleteMessage; once another consumer picks this message up,
  // this handle is stale. So ack()/deadLetter() after nack() WITHOUT an
  // intervening receive() is unsupported - re-receive and use the new id.
  //
  // Verified against LocalStack 4.14.0: it accepts the stale handle and
  // deletes the message. That is LocalStack being lenient, not a contract
  // real SQS offers, which is exactly why this is documented rather than
  // pinned by a contract test - the test would encode LocalStack's
  // behaviour and pass while production diverged. pgmq has no equivalent
  // hazard: its ids are stable message ids, not lease tokens.
  async nack(id: string): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: id,
        VisibilityTimeout: 0,
      }),
    );
    // Body stays cached: eviction is ack()/deadLetter()'s job, and the
    // cache is per-instance and short-lived.
  }

  async deadLetter(id: string): Promise<void> {
    const body = this.received.get(id);
    if (body === undefined) {
      throw new Error(
        `deadLetter(${id}): no cached body - id must come from receive() on this adapter instance`,
      );
    }
    await this.client.send(
      new SendMessageCommand({ QueueUrl: this.dlqUrl, MessageBody: JSON.stringify(body) }),
    );
    await this.client.send(
      new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: id }),
    );
    this.received.delete(id);
  }
}
