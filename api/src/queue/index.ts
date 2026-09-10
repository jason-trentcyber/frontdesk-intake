// ADR-0004: the five operations, no more. Selection by QUEUE_PROVIDER env
// only - no auto-detection, no other switch.

export interface QueueMessage<T> {
  /** Opaque handle to ack/nack/deadLetter this specific receive - not a
   * stable message identity (SQS's is a receipt handle, not a message id;
   * pgmq's is the row's msg_id, which happens to be stable, but treat
   * both the same way). */
  id: string;
  body: T;
}

export interface Queue<T> {
  /** Enqueues payload; resolves to a provider message id (informational -
   * you cannot ack/nack/deadLetter with it, only a QueueMessage.id from
   * receive() can). */
  send(payload: T): Promise<string>;
  receive(visibilityTimeout: number, qty?: number): Promise<QueueMessage<T>[]>;
  ack(id: string): Promise<void>;
  /** Makes the message immediately visible again (vt -> 0 / now). */
  nack(id: string): Promise<void>;
  deadLetter(id: string): Promise<void>;
}

// pgmq queue tables have NO row-level security (rowsecurity = f on
// q_*/a_*, verified against the pinned image) - the queue is
// cross-tenant storage, the one place in this system tenancy is not
// enforced by the database. Every payload MUST carry orgId; the consumer
// (worker/) is responsible for opening forOrg(orgId, ...) before
// touching any tenant table.
export interface TriageMessage {
  orgId: string;
  requestId: string;
}

export const QUEUE_NAME = "frontdesk_triage";
