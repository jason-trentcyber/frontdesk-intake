# ADR-0018: Tenancy data layer — Drizzle schema + RLS policies versioned together, `SECURITY DEFINER` entry-point resolvers, migrations from an in-cluster Job; amends ADR-0003 and ADR-0007

Status: decided 2026-09-09; implementation tracked in #21 (the `db/` package, tests, CI job, migrate image and chart Job land in follow-up PRs, not this one). Supersedes the mechanism clauses "Prisma middleware injects `where.org_id`" (ADR-0007) and "via the Prisma adapter" (ADR-0003). Everything else in both ADRs stands: two seeded orgs, `org_id NOT NULL` + FK on every tenant table, RLS as the second layer, email allow-list membership, Auth.js with Google and GitHub, identities in our Postgres.

## Context

#21 was written on 2026-09-07 as "Prisma schema, migrations, RLS policies, seeds". Facts checked on 2026-09-09 before briefing it:

- **Prisma middleware no longer exists.** `$use` was removed in Prisma 7; the replacement is a client extension, and Prisma 7 requires a driver adapter. Prisma 8 (`prisma@latest` since 2026-08-28, still tagged RC on npm) is a rewrite: no generated `PrismaClient`, a new query DSL, TypeScript graph migrations, extensions via an SPI, and its own guides for pgvector, multi-tenancy, Docker deployment and testing all listed as "coming as they land". `@auth/prisma-adapter` targets the Prisma ≤7 client API.
- **`CREATE EXTENSION vector` needs superuser** (`vector.control` is not `trusted`), and the migration role `frontdesk` is `NOSUPERUSER NOCREATEDB` by ADR-0016. Prisma Migrate's shadow database therefore cannot be created or given the extension by the role that runs migrations — a dev-only workaround (a second `initdb` script gated by an env var) would have been needed purely to satisfy the tool.
- **The columns ADR-0005 needs — `vector(384)`, a generated `tsvector`, HNSW and GIN indexes — and ADR-0007's RLS policies** have no representation in Prisma's schema language; they live in hand-edited migration SQL the schema does not know about, which is exactly the part a tenancy review needs to read.
- **Migrations cannot run from the CI runner.** ADR-0014's ACL allows `tag:ci → node:6443` only and the deployer ServiceAccount has no `pods/exec` (ADR-0016). ADR-0016 already reserves `batch/jobs` for "the Prisma migration Job from #21 as a Helm hook"; this ADR names the image that Job runs.
- **Three reads must happen before an org context exists:** a staff member's email at sign-in (ADR-0003), an API key by hash (F3), a tracking token (F2). Any RLS design has to say where those holes are.

## Decision

### Data-access library: Drizzle ORM (`drizzle-orm` 0.45.x + `drizzle-kit` 0.31.x over `pg`)

- Schema is TypeScript in a new workspace package **`db/`** (`@frontdesk/db`), consumed by `web/` and `api/`. The Python worker uses raw SQL over psycopg against the same tables and follows the same `app.org_id` rule (its acceptance lives in #23/#24).
- `pgvector`'s `vector(384)`, the generated `tsvector` (`generatedAlwaysAs`), the HNSW index (`.using('hnsw', …)`, `m=16, ef_construction=64`, cosine) and GIN index, `ENABLE ROW LEVEL SECURITY` and every policy (`pgPolicy`) are declared **in the schema file**, so `drizzle-kit generate` emits them and a PR diff shows a table and its policy together. What the schema language cannot express — the `current_org_id()` helper, the three resolver functions, `GRANT`s, and the extension assertion — goes in `drizzle-kit generate --custom` migration files in the same directory, in order.
- No shadow database. `drizzle-kit` diffs against its own committed snapshots. ADR-0016's role model is untouched.
- Versions are pinned; Dependabot's `minor-patch` group keeps them current. Drizzle is pre-1.0 by label but has had a stable public API and a large install base for several years; the revisit trigger is a breaking `drizzle-orm` 1.0 release, handled as an ordinary major-bump PR.

### Schema (tenant tables and shapes; column detail in `db/src/schema/`)

- `uuid` primary keys (`gen_random_uuid()`), `timestamptz` everywhere, `snake_case` columns, real Postgres enums.
- **`orgs`** (`slug` unique, `name`, `is_demo`, `daily_token_budget` default 200000, `settings jsonb` validated by a zod schema in `db/` — categories → lanes map, similarity floor override). Not a tenant table; **read-only from the app role in v1** (`SELECT` only): org configuration changes by seed or migration until a settings UI is a requirement. REQUIREMENTS §2 gives owners documents and the allow-list, nothing more.
- Tenant tables, each with `org_id uuid NOT NULL REFERENCES orgs(id)`: **`org_members`** (`email citext`, `role enum(owner, staff)`), **`api_keys`** (`key_hash` sha-256, `prefix`, `name`, `last_used_at`, `revoked_at`), **`requests`** (`source enum(form, api)`, requester fields, `subject`, `body`, `tracking_token` unique, `status enum(received, triaging, drafted, needs_human, approved, rejected)`, `category`, `urgency enum(low, normal, high)`, `summary`, `lane`, `reply_text` snapshot written at approve, `resolved_at`), **`drafts`** (`request_id`, `version`, `body`, `citations jsonb`, `confidence numeric(4,3)`, `model`, `prompt_version`, `tokens_in`, `tokens_out`), **`actions`** (`request_id`, `actor_email`, `kind enum(approve, edit, reject)`, `before jsonb`, `after jsonb`, `reason`), **`documents`** (`title`, `filename`, `mime`, `sha256` unique per org, `raw bytea`, `text_content`, `status enum(pending, indexed, failed)`, `chunk_count`, `error`), **`chunks`** (`document_id` cascade, `ord`, `text`, `tsv` generated, `embedding vector(384)` nullable).
- **Tenant → tenant references are composite foreign keys** on `(org_id, <parent_id>)` against a `(org_id, id)` unique on the parent, so a cross-org reference is a constraint violation, not merely an RLS miss.
- **`org_members.email` is unique globally** in v1, not per org: a staff member belongs to exactly one org (REQUIREMENTS §2, ADR-0003), so sign-in resolves to one row or none. Relaxing it later is one dropped index plus an org picker; the resolver below is the call site that would not change.
- Per-org daily LLM budget (ADR-0007) is `sum(tokens_in + tokens_out)` over today's `drafts`; no separate usage table.
- Auth.js tables (`users`, `accounts`, `sessions`, `verification_tokens`) are **not** in #21; #26 adds them through `@auth/drizzle-adapter`. `org_members` is keyed by email, not by Auth.js user id, so nothing here depends on them. pgmq's queue tables stay in schema `pgmq`, outside Drizzle.

### Row-level security

- One policy shape on every tenant table: `USING (org_id = current_org_id()) WITH CHECK (org_id = current_org_id())`, where `current_org_id()` is `STABLE` and returns `NULLIF(current_setting('app.org_id', true), '')::uuid` — unset or empty → `NULL` → zero rows, never an error, never everything.
- `actions` and `drafts` get `SELECT` and `INSERT` policies only: append-only for the app role regardless of table-level grants (F12 audit).
- No `FORCE ROW LEVEL SECURITY`. `frontdesk` owns the tables and runs migrations and seeds; `frontdesk_app` is subject to RLS because it is `NOBYPASSRLS` and not the owner (ADR-0016 created the two roles for this).
- **Entry-point resolvers.** The three pre-context reads are `SECURITY DEFINER` functions owned by `frontdesk`, `SET search_path = public`, exact-match arguments, returning only the identifiers needed to open a scoped session — `resolve_membership(email) → (org_id, role)`, `resolve_api_key(hash) → (org_id, api_key_id)` (also stamps `last_used_at`), `resolve_tracking(token) → (org_id, request_id)` — with `EXECUTE` granted to `frontdesk_app`. Every table policy stays identical and grep-able; the unscoped surface is exactly three functions that cannot list anything.
- Grants: `initdb/002-roles.sh` already sets default privileges so every table and sequence the migration creates is DML-granted to `frontdesk_app`. Functions are not covered by that and are granted explicitly; `drizzle.__drizzle_migrations` is revoked from `frontdesk_app`.

### Client (`db/src/client.ts`)

- `db` — the base `drizzle(pg.Pool)` instance on the app role. Used directly only for `orgs` reads and the three resolvers.
- `forOrg(orgId, fn)` — runs `fn(tx)` inside one transaction that first executes `SELECT set_config('app.org_id', $1, true)`. All tenant reads and writes in `web/` and `api/` go through it; the GUC is transaction-local so pooled connections cannot leak a context.
- Belt and braces: `forOrg` also passes `orgId` to the caller so every `where`/`insert` carries it explicitly; RLS is the backstop, not the only line.
- **Coverage test** (replaces the issue's "middleware coverage test"): iterate every table exported from `db/src/schema`, and for each one that is not in an explicit `NON_TENANT_TABLES` allow-list (`orgs` only), assert it has an `org_id` column, has RLS enabled, and has at least one `pgPolicy`. A second test runs as `frontdesk_app` over raw `pg`: zero rows without `set_config`, N with, a cross-org `INSERT` rejected by `WITH CHECK`, an `UPDATE actions` rejected.

### Migrations

- Generated by `drizzle-kit generate` (plus `--custom` files), committed, forward-only, never edited after apply (conventions.md).
- **CI** (`ci.yml`, new `db` job): Postgres service container = the chart-pinned `ghcr.io/jason-trentcyber/frontdesk-postgres@sha256:…` image, so roles and extensions match production exactly. Steps: migrate as `frontdesk`, `pnpm seed` twice, vitest (coverage + RLS tests), `drizzle-kit check` as the drift gate.
- **Production**: Helm hook Job **`frontdesk-db-migrate`** (`pre-install,pre-upgrade`, `hook-delete-policy: before-hook-creation,hook-succeeded`, `backoffLimit: 0`, waits for Postgres before running) executes the programmatic `migrate()` from `drizzle-orm/node-postgres` then the seed. A failing migration fails the release before `web` rolls — `helm --wait` is the guardrail. Credentials per ADR-0017: this Job is the only pod that references `frontdesk-password`.
- **Image: `ghcr.io/jason-trentcyber/frontdesk-db`** from `db/Dockerfile` (node:22-alpine, the compiled migration runner, `drizzle/` SQL, seed data). Built and digest-pinned by `deploy.yml` beside `frontdesk-web` (`--set db.image.digest=`). Pod labels: `app.kubernetes.io/component: db-migrate`, `part-of: frontdesk` (NetworkPolicy), matching no Service selector (#75). Also the future home of the ADR-0005 `reindex` job.

### Seeds (`pnpm seed`, runs as `frontdesk`, idempotent)

Create-if-missing by natural key (`orgs.slug`, `org_members.email`, `(org_id, sha256)`, `(org_id, tracking_token)`); never overwrites. Seeds both orgs (`bright-smile-dental` `is_demo = true`, `harbor-legal`), one owner each from `SEED_OWNER_EMAIL` (default `owner@example.com`; a real address never enters the repo), ~4 fictional Markdown documents per org (`status = pending`; #24 indexes them), and ~6 fictional demo-org requests with drafts marked `model = 'seed'` so the landing-page queue (F16) has content before the worker exists. No API keys are seeded.

### Review rule (conventions.md, review-agent tenancy rubric)

A PR that adds a tenant table shows, in the same schema file: the `org_id` column, `.enableRLS()`, the `pgPolicy` — and the coverage test still passes. A PR that adds a `SECURITY DEFINER` function or a policy that does not compare `org_id` to `current_org_id()` gets the `security` label and a human review.

## Consequences

- ADR-0003 "Prisma adapter" → `@auth/drizzle-adapter` (#26); ADR-0007 "Prisma middleware" → `forOrg()` + the coverage test. `docs/conventions.md` and the `CLAUDE.md` ADR map are updated in this PR.
- `deploy.yml` builds two images. `values.yaml` gains `db.image.*`; the chart gains the hook Job template.
- The Python worker duplicates the `set_config` rule in its own DB layer; the RLS test above is what keeps both honest.
- Enum changes are `ALTER TYPE … ADD VALUE` in their own migration file (cannot run inside the same transaction as a use of the value).

## Acceptance (replaces the #21 issue body's)

1. Migrations apply clean to the chart-pinned image in CI and via the hook Job on the live cluster.
2. Coverage test: every exported table except `orgs` has `org_id`, RLS enabled, a policy.
3. As `frontdesk_app`: `SELECT count(*) FROM requests` is 0 without `set_config`, N with; cross-org insert and any `UPDATE actions` fail.
4. `pnpm seed` twice → identical row counts.
5. Live: `helm upgrade` from `main` runs `frontdesk-db-migrate`; `\dt` shows tables owned by `frontdesk`; `\dp requests` shows the policy; the three resolvers exist with `frontdesk_app` `EXECUTE` and nothing else unscoped.

## Rejected

- **Prisma 7.10.** Works, and was the first draft. Rejected for the shadow-database workaround the NOCREATEDB/superuser-extension combination forces, for keeping the vector/tsvector/RLS DDL outside the schema, and because the client-extension transaction pattern nests badly inside interactive transactions (approve = update + audit insert). Prisma 8 additionally: still an RC on npm, replaces the client API this design would build on, has no published multi-tenant/pgvector/Docker guides, and `@auth/prisma-adapter` does not target it. Revisit trigger: none planned — Drizzle covers the need.
- **Kysely.** Same SQL-shaped benefits, but no schema object to reflect on, so the coverage test becomes a `pg_policies` query and the DDL is all hand-written; more boilerplate for the same result.
- **Raw SQL + `node-pg-migrate`.** Right for the Python worker; in `web/`/`api/` every row shape becomes a hand-typed interface, which is where an agent drifts.
- **Loosening policies for the entry points** (`… OR email = current_setting('app.actor_email')` on `org_members`, similar on `api_keys`/`requests`). Works, but three bespoke policies weaken the "every policy is identical" invariant the coverage test relies on.
- **Migrations from CI over the tailnet.** Would open 5432 to `tag:ci`; the ACL is deliberately 6443-only.
- **Migrations at application start.** Replicas race, and the app role cannot run DDL by design.
- **`kubectl exec` migrations from the VPS.** Kept as the manual fallback in the runbook, not a deploy path.
- **Per-tenant schemas / databases.** Already rejected in ADR-0007.
