# ADR-0025: Ingestion is triggered by its own queue; `reindex` runs from the worker image; embedding batches are capped at 32

Status: decided 2026-09-11

Amends ADR-0004 (a second queue and a second message contract), ADR-0005
(the `reindex` job's mechanism) and ADR-0018 (which image hosts that job).
None of their decision text changes; the clauses each one owns are named
below with what replaces them.

## Context

#23 landed the worker: it consumes `pgmq.frontdesk_triage`, validates each
message against `docs/contracts/triage-message.schema.json`, opens a
tenant-scoped transaction, and calls a `run_triage_pipeline` stub. It is
running on the cluster now, idle, because nothing enqueues to it yet.

#24 is the ingestion pipeline: chunk a document, embed each chunk with
`bge-small-en-v1.5` on ONNX Runtime (ADR-0023 §3), write `chunks` rows,
and let `/api/v1/orgs/<slug>/index-info` report a non-zero count. Its issue
body describes the *transformation* completely and says nothing about what
starts it. Reading it against the repo as it exists today surfaces four
mechanism questions that the body does not answer and that an implementer
would therefore have to invent:

**1. Nothing can trigger ingestion.** The only queue is `frontdesk_triage`
and its contract is `{orgId, requestId}` with `additionalProperties: false`
— a strictness that #23's review deliberately tightened. A document message
cannot ride it. Meanwhile `db/src/seed.ts` creates ~4 documents per org at
`status = 'pending'`, and ADR-0018's seed clause says "#24 indexes them",
naming no mechanism.

**2. No upload path exists.** REQUIREMENTS F14 gives the Owner document
upload, and #24's body says "Re-upload replaces". Neither `api/` nor `web/`
has a document route: `api/src/routes/` is `healthz`, `readyz`,
`index-info`, `requests`. #26 is the staff queue UI and #27 is the public
form; neither includes upload. So "re-upload replaces" currently describes
a path with no entry point.

**3. ADR-0018 puts `reindex` in an image that cannot run it.** Its line on
the `frontdesk-db` image (node:22-alpine, migrations and seeds) ends "Also
the future home of the ADR-0005 `reindex` job." Reindexing re-embeds every
chunk; the embedder is Python + ONNX Runtime, in the worker image. A Node
image cannot perform it. This is the same class of error as ADR-0016's
"the chart renders a Secret from the SealedSecret's plaintext" — a
mechanism clause naming a layer where the mechanism cannot exist.

**4. Embedding batch size is unspecified, and it is the live OOM risk.**
The worker's chart limit is 512Mi, chosen in ADR-0023 §3 precisely to fit
this model. That ADR's 377 MB peak-RSS figure was measured encoding **32
chunks** in one pass. Nothing records that 32 is load-bearing, so an
implementation that embeds a whole document in a single batch is consistent
with every written decision and can still be OOMKilled. Measured on the live
node after #23 deployed (2026-09-11): worker pod 36Mi of its 512Mi limit;
node 2251Mi used of 3820Mi allocatable; chart limits sum to 3434Mi = 90 % of
allocatable, matching ADR-0023's predicted ~89 %.

## Decision

### 1. A second queue, `frontdesk_ingest`, with its own contract

Ingestion is triggered by a message on a **new pgmq queue** named
`frontdesk_ingest`, carrying `{orgId, documentId}`, validated by a new
committed contract file `docs/contracts/ingest-message.schema.json`
generated from a Zod schema in `api/` exactly as
`triage-message.schema.json` is (ADR-0023 §2), with the same
byte-for-byte drift test.

`frontdesk_triage` and its contract are unchanged.

The worker consumes both queues in one process (ADR-0023 §4 — one worker,
one resident model). Each message is dispatched to its own pipeline by the
queue it arrived on, not by inspecting its body.

Provisioning follows ADR-0022 unchanged: `api/`'s `ensureQueue()` at
startup, as `frontdesk_app`, extended to create both queues. The worker
still never creates a queue and cannot.

### 2. `documents.status` is the ingestion state machine

The existing `document_status` enum (`pending`, `indexed`, `failed`) and
`documents.chunk_count` are the state; no migration is needed. The worker
sets `status = 'indexed'` and `chunk_count` on success, `status = 'failed'`
with `documents.error` on a permanent failure. `pending` is the initial
state the seed already writes.

Re-ingesting a document deletes its existing `chunks` rows and writes new
ones in the same transaction, so a re-run is idempotent and a partial
failure leaves no half-indexed document.

### 3. #24 ingests seeded documents only; upload is a separate issue

#24's scope is the pipeline: consume `frontdesk_ingest`, chunk, embed,
write `chunks`, update `documents`. It adds **no upload route** and no UI.
The documents it ingests are the ones `db/src/seed.ts` already creates.

The trigger for those seeded documents is a **one-shot enqueue at `api/`
startup**, beside `ensureQueue()`: select `documents` with
`status = 'pending'`, enqueue one `frontdesk_ingest` message each. This is
idempotent in the sense that matters — a document that has been indexed is
no longer `pending`, so a restart does not re-enqueue it.

F14's upload path (route, MIME/size validation, `raw` storage, re-upload
replacement, the Owner UI) is a new issue, blocked on #26's auth because
"the Owner" is not identifiable until membership exists.

### 4. Embedding batches are capped at 32 chunks

The worker embeds in batches of at most **32 chunks**, the batch size
ADR-0023 §3's 377 MB measurement was taken at. A document producing more
chunks is embedded in successive batches.

Any PR changing this number must re-measure peak RSS on 2 vCPU and report
it, because the 512Mi chart limit and the 90 %-of-node figure both depend
on it.

### 5. `reindex` is a Job built from the worker image

The ADR-0005 `reindex` job runs the worker image
(`ghcr.io/jason-trentcyber/frontdesk-worker`) as a Kubernetes Job with a
distinct entrypoint, not the `frontdesk-db` image. ADR-0018's "Also the
future home of the ADR-0005 `reindex` job" is superseded by this clause.
ADR-0010's requirement that reindex run as a Job rather than an always-on
pod is unchanged and is satisfied by this.

Building the job itself is **not** in #24's scope; this clause fixes which
image it belongs to so the next issue does not rediscover the problem.

## Consequences

- The worker grows a second consumer loop. ADR-0023 §4's revisit trigger
  (F9's 10 s p95) now has a second contributor: a long ingestion batch
  delays triage messages in the same process. The trigger is unchanged, but
  ingestion is the more likely thing to trip it, and splitting the two into
  separate Deployments would need 512Mi that the node does not have —
  measured headroom is 386Mi under allocatable. So the realistic response to
  that trigger is a bigger node, not a second pod. That is worth knowing
  before the trigger fires.
- `api/` gains a second queue name, a second Zod schema, and a startup
  enqueue. It remains the only queue producer (ADR-0021).
- `index-info`'s `chunkCount` becomes non-zero for the first time, which is
  what makes F15 demonstrable.
- Two documents that are byte-identical within an org are already prevented
  by `documents_org_id_sha256_unique`, so ingestion has no de-duplication
  work of its own.
- A failed ingestion leaves `status = 'failed'` and an error string that no
  UI surfaces yet. That is honest rather than hidden, and it is visible in
  `index-info`'s counts by absence.

## Rejected

- **A second message type on `frontdesk_triage`.** Would mean relaxing
  `additionalProperties: false` or adding a discriminator to a contract that
  #23 deliberately tightened, and every consumer would branch on message
  shape. Two queues cost one `pgmq.create()` call and keep both contracts
  exact.
- **Polling `documents where status = 'pending'` on a timer.** Simpler, and
  it needs no contract — but it discards the retry, visibility-timeout and
  dead-letter machinery #23 already built and tested, and reintroduces
  "how often do we poll" as a new tunable. A queue the repo already has two
  adapters for is the cheaper mechanism.
- **Ingesting inline when a document row is created.** There is no code
  path that creates one outside the seed, and doing the work inside the
  writer's transaction would put a multi-second embed on a request thread.
- **Letting #24 add the upload route as well.** It is a second, independent
  change (HTTP surface, MIME sniffing, size limits, `raw` bytes, PDF text
  extraction) on top of an already large one, and it cannot be finished
  correctly before #26 defines who the Owner is.
- **Leaving the batch size to the implementer.** ADR-0023 §3 spent a
  measurement to justify 512Mi; leaving the parameter that measurement
  depends on unstated would let a correct-looking implementation invalidate
  it.
- **Moving the embedder into the `frontdesk-db` image to satisfy ADR-0018's
  sentence.** That would put ONNX Runtime and a Python toolchain into a
  Node migration image to preserve a line of prose. The image follows the
  runtime, not the other way round.
