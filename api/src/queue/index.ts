import { z } from "zod";

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
// Single source of truth for the wire shape (#23): docs/contracts/triage-message.schema.json
// is generated from this schema via z.toJSONSchema() (see queue.contract.test.ts, which fails
// the build if the committed file drifts). worker/ validates against the committed JSON file
// directly, not a hand-written Python copy, so the two languages cannot silently diverge.
export const triageMessageSchema = z.object({
  orgId: z.string().min(1),
  requestId: z.string().min(1),
});

export type TriageMessage = z.infer<typeof triageMessageSchema>;

// The type above is erased at runtime, and the queue has no RLS to catch a
// mistake - so an unscoped message would be accepted silently and only
// surface as a worker crash or, worse, a request triaged under the wrong
// org. Assert at the boundary instead. Producers call this before send();
// consumers call it on receive(), because a message written by an older
// build is just as unscoped as one written by a buggy new one.
//
// Delegates to triageMessageSchema (same validation, one definition) but keeps its own
// name, signature, and error text: requests.ts and its tests depend on both.
export function assertTriageMessage(value: unknown): asserts value is TriageMessage {
  const result = triageMessageSchema.safeParse(value);
  if (result.success) {
    return;
  }
  const issues = result.error.issues;
  // A root-level issue (value isn't an object at all, e.g. null/undefined)
  // has an empty path; treat it as touching every field, matching the old
  // `!m` check's precedence of failing on orgId first either way.
  const touches = (field: string) =>
    issues.some((issue) => issue.path.length === 0 || issue.path[0] === field);
  if (touches("orgId")) {
    throw new Error("TriageMessage.orgId is required - the queue has no RLS to enforce tenancy");
  }
  if (touches("requestId")) {
    throw new Error("TriageMessage.requestId is required");
  }
  throw new Error("TriageMessage is invalid");
}

export const QUEUE_NAME = "frontdesk_triage";
