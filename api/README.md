# api

`@frontdesk/api` — the external integration surface and the sole `Queue`
producer (**ADR-0021**, refining ADR-0004). Read that ADR first: `api/`
is what other systems call (F3's API-key intake, F15's `index-info`); it
is not a REST facade for `web/`, which reads and writes through
`@frontdesk/db` in-process instead.

## Endpoints

- `GET /healthz` — liveness, no DB call.
- `GET /readyz` — readiness, one `SELECT 1`. The chart's `readinessProbe`
  uses this; `/healthz` (the `livenessProbe`) must not fail when the DB
  blips.
- `POST /api/v1/orgs/:slug/requests` (F1/F3) — the intake path. Exactly
  one auth mode per request:
  - API key: `Authorization: Bearer <key>`. Wrong or revoked key -> 401.
    Valid key but the resolved org doesn't match `:slug` -> **404, not
    403** (never confirm a different org owns this slug to whoever holds
    the key).
  - Turnstile: `cf-turnstile-response` in the body, verified against
    Cloudflare. This is how `web/`'s public form (#27) submits - server
    side, through this same endpoint, not a separate code path.

  Both present or neither -> 400. On success: one `forOrg(orgId, ...)`
  transaction inserts the `requests` row, then - **after that
  transaction commits** - the request is enqueued as `{ orgId,
  requestId }`. Enqueuing inside the transaction would risk a queued
  message pointing at a row a rollback later erased; enqueuing after
  means a crash between commit and enqueue instead risks a request that
  exists but is never triaged; the second failure is recoverable (a
  human can requery `requests` for `status = 'received'` with no draft)
  and the first isn't (worker/'s consumer, ADR-0018, would `forOrg()` an
  id that was never actually committed).
- `GET /api/v1/orgs/:slug/index-info` (F15) — demo org only; any other
  org, or a slug that doesn't exist, both 404 identically.

Errors are RFC 9457 `application/problem+json` (`type`, `title`,
`status`, `detail`).

## The `Queue` interface (ADR-0004)

`api/src/queue/`: `send`/`receive`/`ack`/`nack`/`deadLetter`, selected by
`QUEUE_PROVIDER` (`pgmq` | `sqs`) only. **Every payload carries `orgId`
and `requestId`** - pgmq's queue tables have no row-level security
(`rowsecurity = f` on `q_*`/`a_*`, verified against the pinned image),
so the queue is the one place in this system tenancy is not enforced by
the database. The consumer (`worker/`) must open `forOrg(orgId, ...)`
before touching any tenant table.

`PostgresQueue` (pgmq): `send`/`read`/`delete` (ack)/`set_vt(...,
0)` (nack)/`archive` (dead-letter - **there is no `pgmq.dead_letter`**,
checked directly against the pinned image: `proname ilike '%dead%'`
returns 0 rows. `archive()` moves the row from `q_<queue>` to
`a_<queue>` server-side, which is "removed from the main queue" without
needing the message body).

`SqsQueue`: AWS SDK v3, the only file allowed to import `@aws-sdk/*`
(same principle as AGENTS.md's openrouter/bedrock/boto3 rule). `nack` is
`ChangeMessageVisibility` to 0. `deadLetter` sends the body to
`SQS_DLQ_URL` then deletes from the main queue - LocalStack does not
enforce a redrive policy, so this adapter enforces "dead-letter" itself.
SQS's ack/nack take a receipt handle, not a stable id, and a receipt
handle alone can't recover a message's body - the adapter caches it
in-memory from `receive()`, keyed by the same id `deadLetter` is called
with. pgmq needs no equivalent.

### The pgmq queue does not exist until a human creates it - read this before testing locally

The design (this brief) called for `db/drizzle/0005_pgmq_queue.sql` - a
migration, run as `frontdesk` (the owner role, `frontdesk-db-migrate`),
that calls `pgmq.create('frontdesk_triage')` once, guarded to be a
no-op on re-run.

**This does not work.** Verified directly against the pinned image:

```
$ psql "$DATABASE_URL" -c "select pgmq.create('frontdesk_triage');"     # as frontdesk
ERROR:  permission denied for schema pgmq
```

`deploy/postgres/initdb/002-roles.sh` grants `USAGE`/`CREATE` on schema
`pgmq` to `frontdesk_app` only - never to `frontdesk`. `frontdesk` can't
self-grant it (the schema is owned by `postgres`; granting requires
being the owner, a superuser, or already holding the privilege
`WITH GRANT OPTION` - `frontdesk` is none of those, and has no role
membership path to `frontdesk_app` either: `SET ROLE frontdesk_app` as
`frontdesk` returns `permission denied to set role`). This isn't an ADR
conflict - no decided ADR text mandates the migration mechanism, ADR-0016
just documents that pgmq queues get created by `pgmq.create()` without
saying by whom - but it makes the brief's specific approach impossible
as written, so per that brief's own instruction: **stopped and reported
here rather than improvising a different production mechanism** (in
particular, `PostgresQueue` does **not** call `pgmq.create()` itself -
"do not create the queue lazily on first send" stands regardless of this
gap).

**Until this is fixed** (a `deploy/postgres/` follow-up granting
`frontdesk` the same `pgmq` schema privileges `frontdesk_app` already
has - an image-bump PR, ADR-0016's territory, out of scope here), the
queue is provisioned by hand, as `frontdesk_app` (which does have the
grant):

```
psql "$DATABASE_APP_URL" -c "select pgmq.create('frontdesk_triage');"
```

Contract tests and the compose-based local setup do this themselves
(`queue.contract.test.ts` creates and drops its own uniquely-named test
queue in `beforeAll`/`afterAll` - test-fixture setup, not the production
adapter auto-creating anything).

## Local development

```
make up                                           # postgres + localstack
pnpm --filter @frontdesk/db migrate && pnpm seed  # both orgs, no API keys (ADR-0018)
psql "$DATABASE_APP_URL" -c "select pgmq.create('frontdesk_triage');"   # see above
pnpm --filter @frontdesk/api dev                  # tsx watch, :3001
```

No API keys are seeded. Create one by hand against the demo org:

```sql
INSERT INTO api_keys (org_id, key_hash, prefix, name)
SELECT id, encode(sha256('<pick-a-key>'::bytea), 'hex'), '<first-8-chars>', 'local test key'
FROM orgs WHERE slug = 'bright-smile-dental'
RETURNING id;
```

then `Authorization: Bearer <pick-a-key>`.

### SQS locally, against LocalStack

Not needed for `QUEUE_PROVIDER=pgmq` (the default). To exercise the SQS
adapter:

```
aws --endpoint-url http://localhost:4566 sqs create-queue --queue-name frontdesk-triage-dlq
aws --endpoint-url http://localhost:4566 sqs create-queue --queue-name frontdesk-triage
```

then set `QUEUE_PROVIDER=sqs`, `SQS_QUEUE_URL`/`SQS_DLQ_URL` to the
returned queue URLs (`.env.example` has the shape). The contract tests
create and delete their own queues per run - this is only for exercising
the running server by hand.

## Env vars

See `.env.example`. One thing worth calling out: **in the cluster, the
env var is `DATABASE_URL`**, built by the chart's `$(VAR)` expansion from
the `frontdesk_app` role (ADR-0017/0021 - ADR-0021 states explicitly that
`DATABASE_APP_URL` "has no in-cluster counterpart"). Locally,
`.env.example`'s `DATABASE_URL` is the *owner* role (for `db/`'s
migrate/seed) - `api/` must never run as that role, so `api/src/env.ts`
prefers `DATABASE_APP_URL` when present and falls back to `DATABASE_URL`,
which resolves correctly in both places.
