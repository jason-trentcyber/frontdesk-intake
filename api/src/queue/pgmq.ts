import type { Db } from "@frontdesk/db";
import { sql } from "drizzle-orm";
import type { Queue, QueueMessage } from "./index.js";
import { QUEUE_NAME } from "./index.js";

// Verified against the pinned image (ghcr.io/jason-trentcyber/frontdesk-postgres):
//   pgmq.send(queue_name text, msg jsonb) -> SETOF bigint
//   pgmq.read(queue_name text, vt integer, qty integer, conditional jsonb DEFAULT '{}') -> SETOF pgmq.message_record
//   pgmq.delete(queue_name text, msg_id bigint) -> boolean         (ack)
//   pgmq.set_vt(queue_name text, msg_id bigint, vt integer) -> SETOF message_record   (set_vt(..., 0) is nack)
//   pgmq.archive(queue_name text, msg_id bigint) -> boolean        (dead-letter primitive)
// message_record: (msg_id bigint, read_ct integer, enqueued_at timestamptz,
//   last_read_at timestamptz, vt timestamptz, message jsonb, headers jsonb).
// node-postgres returns bigint columns as JS strings by default (verified
// empirically) - no precision loss, no casting surprises.

export class PostgresQueue<T> implements Queue<T> {
  constructor(
    private readonly db: Db,
    private readonly queueName: string = QUEUE_NAME,
  ) {}

  async send(payload: T): Promise<string> {
    const result = await this.db.execute<{ send: string }>(
      sql`select * from pgmq.send(${this.queueName}, ${JSON.stringify(payload)}::jsonb)`,
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error(`pgmq.send('${this.queueName}') returned no rows`);
    }
    return row.send;
  }

  async receive(visibilityTimeout: number, qty = 1): Promise<QueueMessage<T>[]> {
    const result = await this.db.execute<{ msg_id: string; message: unknown }>(
      sql`select msg_id, message from pgmq.read(${this.queueName}, ${visibilityTimeout}, ${qty})`,
    );
    return result.rows.map((row) => ({ id: row.msg_id, body: row.message as T }));
  }

  async ack(id: string): Promise<void> {
    await this.db.execute(sql`select pgmq.delete(${this.queueName}, ${id}::bigint)`);
  }

  async nack(id: string): Promise<void> {
    await this.db.execute(sql`select pgmq.set_vt(${this.queueName}, ${id}::bigint, 0)`);
  }

  // There is no pgmq.dead_letter (checked: `proname ilike '%dead%'`
  // returns 0 rows against our pinned image). archive() is the closest
  // primitive - it moves the row from q_<queue> to a_<queue> server-side
  // ("remove from the main queue"), which needs only the id, unlike
  // SqsQueue's deadLetter which needs the body too.
  async deadLetter(id: string): Promise<void> {
    await this.db.execute(sql`select pgmq.archive(${this.queueName}, ${id}::bigint)`);
  }
}
