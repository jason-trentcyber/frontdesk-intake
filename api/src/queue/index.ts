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

// The type above is erased at runtime, and the queue has no RLS to catch a
// mistake - so an unscoped message would be accepted silently and only
// surface as a worker crash or, worse, a request triaged under the wrong
// org. Assert at the boundary instead. Producers call this before send();
// consumers call it on receive(), because a message written by an older
// build is just as unscoped as one written by a buggy new one.
export function assertTriageMessage(value: unknown): asserts value is TriageMessage {
  const m = value as Partial<TriageMessage> | null;
  if (!m || typeof m.orgId !== "string" || m.orgId.length === 0) {
    throw new Error("TriageMessage.orgId is required - the queue has no RLS to enforce tenancy");
  }
  if (typeof m.requestId !== "string" || m.requestId.length === 0) {
    throw new Error("TriageMessage.requestId is required");
  }
}

export const QUEUE_NAME = "frontdesk_triage";
