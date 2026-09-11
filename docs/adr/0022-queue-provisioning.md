# ADR-0022: `api/` provisions the pgmq queue at startup, not a `db/` migration; amends ADR-0004 and ADR-0018

Status: decided 2026-09-10. Amends ADR-0004 (which defines the `Queue` interface but never says who creates the queue) and ADR-0018 (which places pgmq's tables outside Drizzle but does not say what does create them). Nothing in either is reversed.

## Context

#22's brief said to provision the triage queue from a `db/` migration, running as the `frontdesk` owner role like every other migration. The implementing agent tried it, found it impossible, and stopped — correctly. The brief was wrong, and the reason is worth recording, because "run it as the owner role" is the right answer everywhere else in this system.

**`frontdesk` cannot create a pgmq queue.** It has no privileges on schema `pgmq` at all:

```
frontdesk=> select pgmq.create('frontdesk_triage');
ERROR:  permission denied for schema pgmq
```

and there is no role-membership path from `frontdesk` to `frontdesk_app`, so it cannot borrow them either.

**That is deliberate, and predates this ADR.** `deploy/postgres/initdb/002-roles.sh` grants `CREATE ON SCHEMA pgmq` to `frontdesk_app` and says why:

> pgmq's functions carry no `SECURITY DEFINER`, so `pgmq.create()` runs its internal `CREATE TABLE` as the calling role — `frontdesk_app` ends up owning the queue tables it creates, which is exactly the access it needs on them.

So the queue tables being owned by the *app* role was already the decided design. The brief contradicted a decision that had already been made and justified; the grants were never the gap.

**And something had to create it.** `pgmq.send()` does not auto-create:

```
select * from pgmq.send('frontdesk_triage', '{"orgId":"..."}'::jsonb);
ERROR:  relation "pgmq.q_frontdesk_triage" does not exist
```

With the migration route closed and nothing else provisioning it, the first form submission or API-key intake on a fresh deployment returns 500 — after a green CI run, a passing `helm template`, and a successful `helm --wait`. No static check in this repo catches a queue that does not exist.

## Decision

**`api/` creates the triage queue at startup, as `frontdesk_app`, before the server listens.** `api/src/queue/ensure.ts`, called from `server.ts`.

Three properties make this safe rather than a lazy hack:

1. **Idempotent.** `pgmq.create()` on an existing queue emits `relation "q_frontdesk_triage" already exists, skipping` and succeeds. Every pod start re-asserts it; N replicas racing is fine.
2. **At startup, not on first send.** A queue that cannot be created fails the readiness probe, so the Deployment never becomes ready and `helm --wait` rolls the release back. The failure lands on the deploy, where an operator is watching, instead of on a customer's first form submission. `PostgresQueue` still never issues DDL — `send()` stays a pure producer.
3. **Not a schema change.** This creates no tenant table and no column any application query reads. ADR-0018's rule — schema changes are Drizzle migrations, applied by `frontdesk-db-migrate` — is untouched, because ADR-0018 already excluded pgmq's storage from the Drizzle schema. This ADR just names who does it.

**SQS needs no equivalent.** Terraform owns real SQS queues; `SqsQueue` takes their URLs as configuration. The asymmetry is inherent — pgmq's queues live inside the database the app already has a connection to, and creating one is a `select`.

## Consequences

- `api/` issues exactly one DDL statement, in one file, at one moment. If that ever grows a second, this ADR should be revisited rather than extended by habit.
- Queue tables are owned by `frontdesk_app`, not `frontdesk`. This is the one piece of storage the owner role does not own. `pg_dump` as `frontdesk` still captures them (it reads schema `pgmq` as a superuser-adjacent owner of the database), but a restore drill that assumes uniform ownership will be surprised. Worth checking the next time ADR-0016's drill is run.
- **The queue is provisioned per-environment by whichever `api/` pod starts first**, so a fresh namespace needs no manual step — which is what makes ADR-0019's scratch-namespace fresh-install drill still meaningful once `api/` is in the chart.
- pgmq queue tables have **no RLS** (`rowsecurity = f`, verified). The queue is cross-tenant storage: every payload carries `orgId` and the consumer opens `forOrg()` itself. This is the one place in the system where tenancy is not enforced by the database, and it is enforced by convention plus the `TriageMessage` type instead. #23's worker must not weaken that.

## Alternatives rejected

- **Grant `frontdesk` the same `pgmq` privileges and keep the migration.** Undoes a deliberate decision (initdb 002-roles.sh) to fit a mistaken brief, and would leave queue tables owned by a role that never reads them.
- **Create lazily on first `send()`.** Moves a deploy-time failure to request time, and makes every enqueue pay a `pgmq.create()` round trip or carry a "have I checked?" flag.
- **A separate provisioning Job in the chart.** A second Helm hook, a fourth image or a shared one, and an ordering constraint against `api/`'s rollout — all to run a statement `api/` can run itself in one line at startup. Ceremony without a failure mode it prevents.
- **A manual `psql` line in the README.** What the PR originally shipped. Documented, unrunnable by CI, and silently absent on any environment nobody read the README for.
