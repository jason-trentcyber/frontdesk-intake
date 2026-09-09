# ADR-0007: Two seeded orgs, org_id scoping in Prisma middleware plus Postgres RLS

Status: decided 2026-09-07. The "Prisma middleware injects `where.org_id` … test asserts every tenant model" mechanism is superseded by ADR-0018 (Drizzle `forOrg()` scoped transaction + schema coverage test); the two-org model, `org_id` + FK, and RLS stand.

## Decision
- Orgs: `bright-smile-dental` (public demo) and `harbor-legal` (private). Seeded by `pnpm seed`; all data fictional.
- Every tenant table has `org_id NOT NULL` with a foreign key. Prisma middleware injects `where.org_id` from the session on every query; a test asserts every tenant model has the middleware applied.
- Postgres RLS is enabled on tenant tables; the app role sets `SET LOCAL app.org_id` per transaction. Belt and braces.
- Demo org queue is readable without auth via a dedicated read-only endpoint that strips requester contact fields. A nightly job deletes demo-org requests older than 24 h.
- Per-org LLM token budget per day, default 200k tokens. Over budget: request is stored, not drafted, flagged.

## Rejected
- Schema-per-tenant: overkill for two tenants and complicates migrations.
- Self-serve org creation: out of scope v1; the model supports it without schema change.
