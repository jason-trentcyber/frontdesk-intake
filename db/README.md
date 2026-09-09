# db

`@frontdesk/db` — the Drizzle schema, RLS policies, entry-point
resolvers, migrations, and seeds for the tenancy data layer. Design is
**ADR-0018**; read that first, this file only covers day-to-day mechanics.

## Adding a table

Every tenant table needs, in its own schema file: an `orgId` column
(`uuid().notNull().references(() => orgs.id)` or, if the parent is
itself a tenant table, a composite `foreignKey` on `(org_id,
<parent_id>)`), `.enableRLS()` on the table, and a `pgPolicy` comparing
`org_id` to `current_org_id()`. `db/src/coverage.test.ts` iterates every
exported table not on `NON_TENANT_TABLES` and fails if any of that is
missing — add the table to `db/src/schema/index.ts`'s exports too, or the
test never sees it.

Composite FKs need a matching `unique(org_id, id)` on the parent (see
`requests.ts`, `documents.ts`) — Postgres requires the referenced columns
to have an exact-matching unique constraint, and the id-only primary key
doesn't satisfy `(org_id, id)` by itself.

## Generating a migration

```
pnpm --filter @frontdesk/db generate          # schema changes -> SQL, from the diff
pnpm --filter @frontdesk/db generate --custom --name=<name>   # hand-written SQL (functions, grants, ...)
```

Never hand-edit a generated file after the fact — fix the schema and
regenerate. Custom files are for what the schema language can't express:
this package's `current_org_id()`, the three resolvers, and grants.

**Migration order is dependency order, not "0000 first."** The original
brief for this package assumed `drizzle-kit generate`'s output always
becomes `0000_*`, with `--custom` files numbered after it. That's
`db/drizzle`'s actual layout except for one wrinkle, found by actually
running the migrations against a fresh database (see PR discussion) —
the generated schema file's `CREATE TABLE` statements reference the
`citext` type (`org_members.email`) and its `CREATE POLICY` statements
reference `current_org_id()`, so both must exist first. `0000` and
`0001` here are therefore the extension/function custom files;
`0002_schema.sql` is the generated one; `0003`/`0004` are the resolvers
and grants. Same content the ADR describes, reordered so it actually
applies — verified end to end against the pinned production image.

## Tests

```
make up                                          # postgres + localstack
pnpm --filter @frontdesk/db migrate
pnpm seed
pnpm --filter @frontdesk/db test
```

`coverage.test.ts` needs no database — it inspects the schema objects
directly. `rls.test.ts` and `seed.test.ts` need `DATABASE_URL` and (for
`rls.test.ts`) `DATABASE_APP_URL` pointed at a migrated, seeded database;
both skip (not fail) with a named reason in the test output if those
aren't set, so `pnpm test` at the repo root stays green without Postgres
running.

## What the resolvers are for

Three things need to find an org before any org context exists: a staff
member signing in by email, an API request by key hash, and a tracking
link by token. `resolve_membership`, `resolve_api_key`, and
`resolve_tracking` (`db/drizzle/0003_resolvers.sql`) are the only places
that can look across every org to answer those — `SECURITY DEFINER`,
owned by `frontdesk` (table owners bypass RLS), returning identifiers
only, never a row's data. Everything else goes through `forOrg()`
(`db/src/client.ts`), which sets `app.org_id` for the transaction and
hands it back to the caller to carry explicitly — RLS is the backstop,
not the only line.

## Local env vars

See `.env.example`. `DATABASE_URL` (owner role) and `DATABASE_APP_URL`
(runtime role) are also used by `api/`/`worker/` once they land;
`MIGRATE_DATABASE_URL` is the same connection as `DATABASE_URL` locally,
read specifically by `drizzle.config.ts` and `migrate.ts` so the
production migrate Job's env (`deploy/postgres/README.md`) has one
clearly-named var to set. `SEED_OWNER_EMAIL` is the one real inbox
`pnpm seed` derives both orgs' owner addresses from (plus-addressing —
`org_members.email` is globally unique, so the two owners can't share a
literal address).
