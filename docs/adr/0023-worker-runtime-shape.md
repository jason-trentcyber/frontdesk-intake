# ADR-0023: The Python worker's runtime shape — asyncpg with no ORM, a language-neutral queue contract, ONNX embeddings, one process, four spend controls

Status: decided 2026-09-11

Amends ADR-0005 (embedding runtime), ADR-0004 (queue contract across languages),
and ADR-0006 (spend controls made concrete). Supersedes no decision text.

Evidence notes added 2026-09-11 in response to the review agent on PR #97
(rubric 5 and rubric 7): the reproduction commands in Context, and the
"what the parity check does NOT establish" paragraph in §3. Both record how the
numbers were obtained and what they do not prove. Neither reverses, narrows, or
extends a decision made above, so this is an annotation rather than a
superseding ADR; if a future reader disagrees with that reading, the decisions
themselves are the five numbered clauses and they are unchanged from the merged
version (commit 305de11).

## Context

`worker/` is still `frontdesk_worker/__init__.py` and a version test. Issue #23
is the root of the remaining M3 work — #24 (ingestion) and #25 (triage) both sit
on it — and its body was written on 2026-09-07, before the data layer existed.

Everything the worker needs to talk to is now real and verifiable rather than
planned, which is why this ADR is worth writing before any code:

- `db/` owns the schema, the RLS policies, and the migrations, applied by the
  `frontdesk-db-migrate` Job (ADR-0018, ADR-0019). It is a TypeScript package.
- `api/` owns the sole `Queue` producer and creates the pgmq queue at startup as
  `frontdesk_app` (ADR-0021, ADR-0022). Also TypeScript.
- The worker is Python (ADR-0005 picked `bge-small-en-v1.5` for embeddings;
  ADR-0006 put the `LLMProvider` interface in `worker/llm/`).

So the worker is the first component that crosses the language boundary, and it
crosses it at the two places this system is least defended: the queue (which has
no row-level security) and the tenant tables (which have RLS, but only if the
worker sets the context RLS compares against). Four questions had no decision
anywhere in `REQUIREMENTS.md` or `docs/adr/`, and an implementation PR would
have had to answer them by picking.

The node is the binding constraint on two of them. Measured on the live node
(`frontdesk`, cx23): 3819 MB total, 1521 MB used, **2298 MB available**. Current
pod limits sum to 2922Mi = 76 % of allocatable.

Those figures are reproducible, and should be re-derived rather than trusted when
this ADR is next read (2026-09-11, release revision 16):

```
ssh -i ~/.ssh/frontdesk-node root@167.233.178.242 'free -m'
kubectl --kubeconfig=infra/hetzner/kubeconfig describe node frontdesk \
  | grep -A8 'Allocated resources'
kubectl --kubeconfig=infra/hetzner/kubeconfig top nodes
```

The embedding measurements in §3 come from container probes on the VPS, each run
as `docker run --rm --cpus=2 python:3.12-slim`, taking peak RSS from
`resource.getrusage(RUSAGE_SELF).ru_maxrss` and encoding 32 chunks of
representative text. The parity figures come from encoding the same three strings
with both implementations and comparing the vectors directly. The probe scripts
are reproduced in the #23 implementation PR rather than committed here, since
they are one-off measurements and not a maintained test.

## Decision

### 1. Postgres access: `asyncpg`, hand-written SQL, no ORM in Python

The worker talks to Postgres through `asyncpg` and writes SQL. It does **not**
adopt SQLAlchemy or any other Python ORM.

Tenant access goes through one async context manager that mirrors
`forOrg()` in `db/src/client.ts`:

```python
async with for_org(pool, org_id) as conn:
    # BEGIN; select set_config('app.org_id', $1, true)
    rows = await conn.fetch("select ... from chunks where org_id = $1", org_id)
```

The GUC is transaction-local (`set_config(..., true)`), exactly as on the
TypeScript side, so a pooled connection can never leak one request's org context
into another's. Callers still pass `org_id` in their own `where`/`insert`
clauses: RLS is the backstop, not the only line (ADR-0007, ADR-0018).

**Why.** The schema has exactly one owner — the Drizzle definitions in `db/`,
applied by the migrate Job. A Python ORM would require a second declaration of
those tables that nothing forces to agree with the first; the failure mode is
silent drift discovered at runtime. The worker touches roughly six tables and
writes `drafts` and `actions`. There is no mapping problem here worth a mapper.

Note for the record, since it has caused confusion: Drizzle is a typed SQL
builder, not an ORM, which is part of why ADR-0018 chose it over Prisma. This
decision keeps the repo consistent rather than introducing an exception — SQL in
both languages, schema declared once.

The worker connects as `frontdesk_app` (`NOBYPASSRLS`, per ADR-0016). It gets no
DDL privileges and performs no migrations.

### 2. The queue contract is a file both languages read

`docs/contracts/triage-message.schema.json` is a JSON Schema defining the
message body (`orgId`, `requestId`; both required, both non-empty strings).

- `api/`'s existing `assertTriageMessage` gains a test asserting the messages it
  produces validate against that file.
- The worker validates every received message against the same file before
  touching any tenant table, and dead-letters one that fails.

**Why.** pgmq's queue tables have no row-level security — `rowsecurity = f` on
`q_*`/`a_*`, verified against the pinned image and already documented in
`api/src/queue/index.ts`. The queue is the single place in this system where
tenancy is not enforced by the database, so the shape of the message is the only
thing standing between a producer bug and a request triaged under the wrong org.

Today that shape exists once, in TypeScript. A Python consumer would restate it
by hand, and a rename on either side would then fail at runtime, in production,
on a cross-tenant path. Writing it once in a language-neutral file makes that
failure a red CI check instead. The cost is one small file and a schema
validator in each test suite.

This does not change ADR-0004's five operations or its `QUEUE_PROVIDER`
selection; it pins the payload those operations carry.

### 3. Embeddings run on ONNX Runtime, not torch

ADR-0005's model is unchanged: `BAAI/bge-small-en-v1.5`, 384 dimensions, CPU.
The *runtime* is ONNX Runtime rather than `sentence-transformers` + torch.

Measured on 2 vCPU, 32 chunks of representative text:

| | torch + sentence-transformers (CPU wheel) | ONNX Runtime |
|---|---|---|
| peak RSS | 623 MB | **377 MB** |
| site-packages on disk | 1.4 GB | **194 MB** |
| throughput | 112 ms/chunk | **39 ms/chunk** |

Output parity against the torch implementation, same model, three sample
queries: cosine similarity **1.000000**, maximum element-wise delta **1.3e-07**,
identical cross-document similarity matrices. This is the same weights under a
different runtime, not a quality trade.

**Why it decides anything.** A torch worker needs roughly a 1Gi limit, which puts
chart totals at ~103 % of a 4 GB node — it does not fit. ONNX at 512Mi puts them
at ~89 %, which does. ADR-0010 chose this node deliberately; this is what living
inside it costs.

**What we give up.** `sentence-transformers` is one call; the ONNX path is about
twenty lines (tokenize, run the session, take the CLS token, L2-normalise) and
we own the pooling logic. That code is covered by a parity test asserting the
vectors match recorded reference values, so a pooling mistake fails CI rather
than quietly degrading retrieval.

**What the parity check above does NOT establish.** Three strings compared
vector-to-vector proves the runtime swap is faithful; it says nothing about
retrieval quality on real queries, which is what ADR-0008's eval gate measures.
That gate cannot run yet — `evals/golden/` is an empty directory and the golden
dataset is #30. So this ADR's evidence is deliberately narrow, and the
obligation carries forward: **the PR that lands the ONNX embedding path must run
`make eval` and report recall@5 and classification accuracy against
`evals/baseline.json`**, or, if #30 has still not landed by then, say plainly in
the PR body that the eval gate was unavailable and why. A runtime swap that is
bit-identical on three inputs is not licence to skip the measurement that
matters.

### 4. One worker process

A single Deployment, one replica, consuming the queue and performing ingestion
inline. Not separate ingestion and triage pods.

**Why.** Each process that embeds loads its own copy of the model — two pods is
754 MB at ONNX prices and would be ~1.2 GB at torch prices. One process, one
model in memory. A single replica also means pgmq's visibility timeout is the
only concurrency control required, and ADR-0004 already states one consumer
group.

**Revisit trigger:** if ingestion of a large document set starves triage latency
past F9's 10 s p95 target for the demo org, split the pipelines and pay for the
second model load — on a bigger node, not this one.

### 5. Spend is bounded at four independent layers

ADR-0006 set the interface and the $10/month cap. Measured against OpenRouter's
live pricing for `anthropic/claude-haiku-4.5` ($1.00/M input, $5.00/M output) on
2026-09-11, one triaged request is classify (~600 in / 30 out) plus draft
(~2,800 in / 350 out) = **$0.0053**.

| scenario | cost |
|---|---|
| 50 requests/month (realistic demo traffic) | $0.27 |
| 500 requests/month | $2.65 |
| the $10 key cap | ~1,900 requests |
| eval gate, 60 golden examples | $0.32 per run |
| 20 PRs/month touching `worker/` | $6.36 |

Steady state is under $2/month. The worst case is not steady state: Cloudflare's
Free-plan rate limit permits 10 requests/minute, which sustained is 14,400
requests/day — **$76/day** of LLM spend if nothing else stopped it. Hence four
layers, each of which works when the ones above it have failed:

1. **Vendor cap.** The OpenRouter key is capped at $10/month at the vendor.
   Independent of our code, cannot be exceeded by a bug. Past it, calls fail and
   requests queue undrafted — the intake path keeps working.
2. **Per-org daily token budget**, enforced in the worker (ADR-0006 already
   requires this). A runaway demo org stops; other orgs are unaffected.
3. **Global daily spend ceiling.** On breach the worker switches itself to
   `FakeProvider` for the rest of the UTC day and logs it loudly, rather than
   erroring. The pipeline keeps running end to end with deterministic output, so
   the failure is visible in the UI as obviously-fake drafts instead of silently
   missing ones.
4. **`LLM_PROVIDER=fake`.** One environment variable and a redeploy: immediate
   zero-spend operation with the full pipeline still exercised. The manual
   killswitch.

Layer 3 is new in this ADR; 1, 2 and 4 restate ADR-0006 as operational
requirements of #23 so they cannot be deferred past it.

## Consequences

- `worker/pyproject.toml` gains `asyncpg`, `onnxruntime`, `tokenizers`,
  `huggingface_hub`, `numpy`, and a JSON Schema validator. Not torch, not
  `sentence-transformers`, not SQLAlchemy.
- The worker image must ship the ONNX model file rather than downloading it at
  startup: a cold start that reaches out to the HF Hub is a startup dependency on
  a third party, and the probe run above emitted an unauthenticated-rate-limit
  warning from that API. Bake the model into the image, pinned by revision.
- `docs/contracts/` is a new directory. It is language-neutral by construction
  and belongs to no single service.
- The chart gains a `worker` Deployment with a 512Mi limit. Chart totals go to
  roughly 89 % of the node's allocatable memory, which is the tightest this
  system has been and should be stated in the #23 PR's verification.
- Anyone reading ADR-0005 needs to know the runtime changed; its status line gets
  a pointer to this ADR. Its decision text is untouched.

## Alternatives rejected

- **SQLAlchemy Core with the schema redeclared in Python.** A second definition
  of tables whose single source of truth is `db/`, with drift discovered at
  runtime. Rejected for the reason ADR-0018 exists.
- **An ORM (SQLAlchemy ORM, Tortoise, Piccolo).** Same objection, plus a mapping
  layer for six tables that do not need mapping.
- **Prose contract for the queue message, restated in the ADR.** This is what an
  implementation PR would naturally do. Two hand-maintained copies of a shape
  whose divergence is a cross-tenant bug; the whole point is that no human has to
  notice.
- **Protobuf or Avro for the message.** Real schema evolution and a code
  generator, for a two-field message on a queue with one producer and one
  consumer. The build-time cost exceeds the benefit at this size; revisit if the
  message grows a version field or a third consumer appears.
- **torch + `sentence-transformers`.** One line instead of twenty, and the
  obvious choice on a machine with memory to spare. It does not fit on this node
  alongside Postgres, `web/`, and `api/`.
- **Hosted embeddings.** Already rejected by ADR-0005 (vendor on the core path);
  the memory pressure does not change that reasoning, and it would add per-chunk
  cost to a path that is currently free.
- **Two Deployments (ingestion and triage).** Cleaner separation, double the
  resident model. Deferred to the revisit trigger above.
- **Refusing LLM calls when the global ceiling trips, instead of falling back to
  `FakeProvider`.** Refusing produces requests that sit drafted-never, which
  looks identical to a broken worker. The fake-draft path fails visibly.
