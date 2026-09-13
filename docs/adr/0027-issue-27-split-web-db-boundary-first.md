# ADR-0027: #27 splits into the `web`→Postgres boundary (27a) and the public surface (27b); ADR-0021 is reaffirmed, not superseded

Status: decided 2026-09-13

Narrows #27. Reaffirms ADR-0021 without changing its decision text. Applies
ADR-0017's consumer-credential pattern to a third audience (`web`).

## Context

#25 landed on 2026-09-13 (`b5ae390`). The triage pipeline classifies,
routes, retrieves and drafts with citations, and every M3 backend component
now exists. Nothing renders any of it: the only way to see a cited draft is
to query Postgres by hand.

#27 is the issue that closes that gap. Its body — "`/r/<slug>` (name/email
optional, subject, body, Turnstile). `/t/<token>` status + approved reply.
Landing: one-screen explanation, demo form and live read-only demo queue
side by side" with "Lighthouse accessibility >= 90" — describes the *surface*
completely and says nothing about the boundary underneath it. Read against
the repo as it exists today, that boundary does not exist yet.

**1. `web/` has never talked to Postgres.** The entire application is three
files:

```
web/src/app/healthz/route.ts
web/src/app/layout.tsx
web/src/app/page.tsx      ->  export default function HomePage() {
                                return <p>frontdesk — hello</p>;
                              }
```

`web/package.json`'s dependencies are `next`, `react`, `react-dom`. There is
no `@frontdesk/db`. ADR-0021 decided that `web/` imports that package and
reads in-process; the decision is recorded and the wiring was never built,
because until #25 there was nothing to read.

**2. The `web` Deployment has no database credential.** Its container env is
`PORT`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY`. The pattern it needs
already exists one file away: `templates/api-deployment.yaml` reads
`PGHOST`/`PGPORT`/`PGDATABASE` and `APP_PGUSER` from the
`frontdesk-postgres-connection` ConfigMap, `PGPASSWORD` from the
`frontdesk-app-password` key via `secretKeyRef`, and assembles
`DATABASE_URL` by Kubernetes `$(VAR)` expansion — ADR-0017's pattern,
exactly. `web` is the third audience for it and introduces no new mechanism.

**3. `web`'s tests have never needed a database, and CI reflects that.**
Root `pnpm test` is `pnpm -r test`, so `web`'s tests run inside `ci.yml`'s
`node` job, which has no `services:` block. The `db` and `api` jobs each run
a Postgres service container pinned to the chart's own image digest
(`ghcr.io/jason-trentcyber/frontdesk-postgres@sha256:6b99f66…`) so roles and
extensions match production. The first `web` page that reads through
`forOrg()` makes that job's shape wrong, and fixing it is a CI change
unrelated to any page's markup.

**4. `turnstile.sealed.yaml` does not exist.** `deploy/chart/sealed/`
contains only `postgres-credentials.sealed.yaml`. `values.yaml` carries the
site key (public, harmless) and both Deployments reference the secret with
`optional: true` precisely so the absence does not block anything yet.
Sealing it requires the `infra/cloudflare` Terraform output and
`kubeseal`; per `docs/AI-GOVERNANCE.md` no agent touches secrets, so it is
a human step. It blocks the public form. It does not block a database read.

**5. So #27 as written is five unrelated risk areas plus an accessibility
gate in one diff**: the `@frontdesk/db` dependency and its connection
lifecycle under Next's runtime, a chart credential change, a CI job
restructure, three page surfaces, a third-party widget integration, and
Lighthouse >= 90. A failure in any one is indistinguishable from a failure
in the others, on the surface that is most visible to anyone reading this
repo. This is the same shape ADR-0025 addressed for #24: an issue body that
specifies a transformation and leaves its mechanism to be invented by the
implementer.

## Decision

### 1. ADR-0021 stands, unchanged

`web/` reads and writes through `@frontdesk/db` in-process. It does not
proxy reads through `api/`. Neither this ADR nor #27 revisits that; the
revisit trigger ADR-0021 names is unchanged and has not fired ("when `web`
must run where it cannot open a Postgres connection, or when a second
consumer needs the same reads `web` performs").

Because the phrase "never proxies reads through `api/`" is easy to misread
as a statement about the whole system, this ADR records what the
architecture is, so future readers do not have to re-derive it:

- **Four independently built, versioned and deployed services** — `web`,
  `api`, `worker`, `postgres` — four images, four digests pinned at deploy
  time, separate Dockerfiles, separate CI jobs, separate NetworkPolicies.
  `worker` does not share a process, a runtime, or a language with the
  others.
- **Three of the four inter-component edges are network protocols**:
  third party -> `api/` is versioned REST (`/api/v1/`, API-key auth,
  contract-tested); `web` -> queue goes *through* `api/`, which is the sole
  queue producer (ADR-0021, ADR-0004); `api/` -> `worker` is the queue
  itself, with a JSON-Schema contract both languages validate
  (`docs/contracts/`).
- **The fourth edge, `web` -> Postgres, is a shared library, not a service
  call.** `@frontdesk/db`'s `forOrg()` is the single tenant-scoping choke
  point; isolation is enforced by RLS in the database, which no HTTP hop
  would strengthen.

The accurate description is a service-oriented architecture with a
versioned public API and a shared tenancy-enforcing data-access library —
not "every component speaks HTTP to every other", which the code would not
support, and not a monolith, which four independently deployable services
are not.

### 2. #27 splits in two, in this order

**27a — the boundary.** One page, one credential path, provable end to end:

- Add `@frontdesk/db` to `web/` and establish the connection lifecycle for
  Next's runtime (one pool per process, not one per request).
- Wire the database credential into the `web` Deployment using ADR-0017's
  pattern verbatim, copied from `api-deployment.yaml`: `APP_PGUSER` from the
  connection ConfigMap, password from `frontdesk-app-password` via
  `secretKeyRef`, `DATABASE_URL` assembled by `$(VAR)` expansion. `web`
  never references `frontdesk-password`; that key stays
  `frontdesk-db-migrate`'s alone (ADR-0017, ADR-0019).
- Give `web`'s database-backed tests a Postgres service container pinned to
  the same image digest the `db` and `api` jobs use.
- Ship **`/t/<token>`** — the tracking page. It is the smallest real surface:
  no authentication, no third-party widget, one row, and its resolver
  (`resolve_tracking()`, `db/drizzle/0003_resolvers.sql`) already exists and
  is already `SECURITY DEFINER`.

**27b — the public surface.** Depends on 27a's boundary being real:

- `/r/<slug>`: the public form with the Turnstile widget, submitting through
  `api/`'s intake path (ADR-0021 — one enqueue implementation, and the demo
  exercises the same code path integrations do).
- The landing page with the live read-only demo queue, contact fields
  stripped per ADR-0007.
- The Lighthouse accessibility >= 90 gate, which belongs with the pages it
  measures.

### 3. The sealed Turnstile secret is 27b's blocker and a human's task

`turnstile.sealed.yaml` must exist before 27b's form can verify a challenge
in the cluster. `deploy/chart/sealed/README.md` has the command. No agent
performs it. 27a is deliberately placed before it so the boundary work is
not queued behind a human step.

### 4. #27 stays open until 27b merges

27a does not close it. The issue's acceptance ("a visitor submits to the
demo org and sees the cited draft appear in the read-only queue without
signing in") is 27b's, and no part of it is satisfied by the tracking page.
Same discipline as ADR-0026 leaving #52 open: an issue is not closed on a
partial implementation, it is narrowed by a linked ADR.

## Consequences

- `web` holds a database credential from 27a onward. ADR-0021 §Consequences
  already accepted this and stated why the blast radius is bounded
  (`frontdesk_app` is `NOBYPASSRLS`, not the table owner, SELECT-only on
  `orgs`, every reachable tenant row bounded by `app.org_id`). Nothing new
  is accepted here.
- `ci.yml` gains a Postgres service for `web`'s tests. Whether that is a
  `services:` block added to the existing `node` job or a new `web` job is
  27a's call to make and record; both keep the digest pin.
- The first user-visible page in this repo is a status page, not the
  landing page. Accepted: it is the one that proves the credential path.
- If 27a shows that Next's runtime cannot hold a connection pool the way
  `forOrg()` assumes, that is the signal ADR-0021's revisit trigger was
  written for, and it surfaces on one page instead of three.

## Rejected

- **Build #27 as one PR.** Rejected on the five-risk-areas argument above.
  The counter-argument — that a tracking page with nothing linking to it is
  an odd thing to ship alone — is real but weak: `/t/<token>` is reachable
  from the `trackingUrl` `api/` already returns on every intake response
  (`api/src/routes/requests.ts`), so it is not unreachable, merely not yet
  linked from a landing page.
- **Do 27b first, so there is something to look at sooner.** The form posts
  through `api/` and would render nothing back without the boundary, so the
  visible result would be a form that accepts input and shows no outcome —
  worse evidence than a working tracking page, and it front-loads the
  dependency on a human sealing a secret.
- **Supersede ADR-0021 and give `web` a read API on `api/`.** Considered
  explicitly on 2026-09-13 and declined. It adds a hop, a typed client and
  request/response schemas for an interface with exactly one consumer we
  control, on a single node where `web` and `api` already share fate.
  ADR-0021's Rejected section argues this at length and nothing has changed
  since; the SaaS Lens's "typically not justified" describes this trade
  directly. The one thing that would reverse it is a portfolio-framing
  decision rather than an engineering one, and it was made in favour of
  keeping the boundary as recorded.
- **Fold the CI Postgres service into a later PR.** Then 27a's tests either
  do not exist or are skipped, and a skipped test in this repo is a CI
  failure by design (`docs/review-rubric.md`).
