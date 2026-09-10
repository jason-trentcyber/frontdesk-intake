# ADR-0021: `web/` uses `@frontdesk/db` directly; `api/` serves external integrations and produces to the queue

Status: decided 2026-09-10. Implements the boundary question #22 leaves open. Refs ADR-0018 (the data-access layer this depends on), ADR-0004 (the `Queue` interface), ADR-0007 (tenancy), ADR-0001 (portable chart).

## Context

#22 says "Fastify, intake endpoints, `Queue` interface" and #27 says "public form with Turnstile, tracking page, landing with read-only demo queue". Neither says whether `web/` reaches Postgres through `api/` over HTTP or through the `@frontdesk/db` package in-process. Nothing in REQUIREMENTS or any prior ADR decides it, and it is not a detail: it determines whether `web/` holds a database credential, whether every page render is a network hop, and what `api/` is actually *for*. Left unstated, the implementing agent picks — the same failure that produced ADR-0014 (#18's "scoped kubeconfig") and ADR-0016 (#20's "CloudNativePG or Bitnami").

What is already true and constrains the answer:

- **Tenant isolation is enforced by Postgres, not by HTTP** (ADR-0018). Every tenant table has `org_id`, RLS policies compare `org_id = current_org_id()`, and `frontdesk_app` is `NOBYPASSRLS` and not the table owner. A connection with no `app.org_id` set returns zero rows — verified live on 2026-09-10: 0 rows without context, 6 with, cross-org insert rejected by `WITH CHECK`, `UPDATE actions` filtered to 0 rows. An HTTP hop in front of that adds no isolation the database is not already enforcing for every connection.
- **`@frontdesk/db` already exists as the single scoping choke point.** `forOrg(orgId, fn)` opens a transaction, sets `app.org_id` transaction-locally, and hands the caller both the transaction and the org id. A coverage test asserts every exported tenant table has `org_id`, RLS enabled, and a policy.
- **One node.** `web` and `api` are pods on the same k3s node sharing one Postgres. They already share a fate; a network call between them cannot isolate a failure that takes the node down.
- **F3 states `api/`'s actual audience:** "REST endpoint `POST /api/v1/orgs/<slug>/requests` ... for integrations." Not "for our own UI".

## What the AWS Well-Architected Framework says (and does not)

Consulted because the Framework is the standard reference for this class of decision. Reported honestly, including where it cuts against this decision.

- **Against, on its face — REL03-BP01 "Choose how to segment your workload":** *"Monolithic architecture should be avoided whenever possible. Instead, carefully consider which application components can be broken out into microservices."* Read literally and without the rest of REL03, that favours splitting. It also names the trade-off in the same passage: *"you now have a distributed compute architecture that can make it harder to achieve user latency requirements and there is additional complexity in the debugging and tracing of user interactions"* and *"increased operational complexity as you increase the number of applications that you are managing."*
- **REL03-BP02 "Build services focused on specific business domains and functionality"** is the qualifier that matters: segmentation is by *business domain*. Request intake and staff triage are one domain served through two delivery channels (a browser and a REST API for integrations). Splitting `web`→`api` splits a delivery channel from its own domain logic, which is not what BP02 asks for. `api/` as the integration surface and queue producer *is* a domain boundary; `api/` as a proxy for our own UI is not.
- **For, and directly on point — the SaaS Lens, "Multi-tenant microservices":** *"SaaS microservices—regardless of their compute model—should introduce libraries, modules, and shared constructs that can push tenant-specific processing into code. These constructs hide the policies and mechanisms that are needed to resolve and apply tenant context."* And, of exactly this decision: *"Breaking these concepts into separate services would add latency and complexity that would typically not be justified."* `@frontdesk/db` with `forOrg()` is that shared construct, described by AWS's own SaaS guidance as a library rather than a service.
- **What the Framework does not say:** it takes no position on whether a server-rendered frontend should call its own backend over HTTP. There is no best-practice ID for this. Anyone claiming the Framework settles it is overreading. Its assumptions also do not hold here — it is written for multi-AZ, horizontally scaled, managed-service deployments, and this is one 4 GB node with local-path storage. Where its guidance depends on those assumptions (independent scaling, blast-radius isolation across AZs), it does not transfer, and this ADR does not lean on it.

The honest summary: the Framework's *general* segmentation advice leans toward more services; its *SaaS-specific* guidance on tenant context explicitly prefers a shared library and warns that making it a service is usually not justified. The SaaS Lens is the more specific document and the one addressing this exact concern, so it governs.

## Decision

- **`web/` imports `@frontdesk/db` and talks to Postgres in-process**, through `forOrg()` for every tenant-scoped read and write. It connects as `frontdesk_app` using `DATABASE_APP_URL` (ADR-0017's per-audience `secretKeyRef`; never `frontdesk-password`).
- **`api/` owns the external surface**: F3's API-key-authenticated `POST /api/v1/orgs/:slug/requests`, F15's `/api/v1/orgs/:slug/index-info`, and its own `GET /healthz`. It is versioned and contract-tested because third parties depend on it (REL03-BP03, "Provide service contracts per API"). It ships as its own image and chart Deployment.
- **`api/` owns the `Queue` producer** (ADR-0004). Both entry points enqueue through it: integrations call `api/` directly; `web/`'s form submission calls `api/`'s intake path server-side rather than reimplementing enqueue. One enqueue implementation, one place where the queue contract lives, and the public form exercises the same code path integrations do — which is what makes the demo evidence rather than a parallel implementation.
- **`web/` never proxies reads through `api/`.** Queue views, request detail, tracking pages and document lists read via `@frontdesk/db`.
- **The `/t/:token` tracking page is served by `web/`** using `resolve_tracking()`, not by `api/`. It is a page a human visits, not an integration endpoint.

So the split is by *audience*, not by layer: `api/` is what other systems call; `web/` is what people use. Both sit on the same tenancy enforcement.

## Consequences

- `web/` holds a database credential. Acceptable because it is the runtime role: `NOBYPASSRLS`, no DDL, SELECT-only on `orgs`, and every tenant row it can reach is bounded by `app.org_id`. Compromising the `web` pod yields exactly the access RLS permits, which is the same access it would obtain by calling `api/` with a valid session.
- A future need to scale `web` reads independently, or to run `web` somewhere without database reachability (edge, a separate VPC on EKS), would force a read API. That is the revisit trigger: **when `web` must run where it cannot open a Postgres connection, or when a second consumer needs the same reads `web` performs.** Until one fires, this stays.
- Contract tests for the queue live in `api/` and cover both adapters (ADR-0004). `web/` gets no queue tests because it has no queue code.
- `web/`'s tests need a database, like `db/`'s do. The `db` CI job's Postgres service container pattern extends to them.
- Two images already build in `deploy.yml`; `api/` makes three. The node has headroom (23% of requests, 45% memory at the time of writing), but this is the component that makes resource budgets worth re-checking (ADR-0010's ~2.8 GB request ceiling).

## Rejected

- **`web/` calls `api/` for everything; `web/` holds no database credential.** The clean-boundary argument, and the reason it loses: on one node it buys no isolation (shared fate), it adds a hop to every page render against a p95 target of 10 s end-to-end that includes an LLM call, and it means maintaining a typed client plus request/response schemas for an interface with exactly one consumer we control. The credential argument is weaker than it looks — `web` would instead hold a session-signing secret, and RLS bounds the database credential's blast radius to what the session would have authorised anyway. The SaaS Lens's "typically not justified" is describing this trade.
- **No `api/` at all; `web/` route handlers serve F3.** Collapses the integration contract into the UI's deployment, so a Next.js change can break a third-party integration, and Fastify's schema/validation story for a versioned public API is better than bolting it onto app routes. F3 exists precisely because there is an audience that is not our UI.
- **`api/` owns all writes, `web/` reads directly.** Splits the tenancy story in half — writes enforce scoping in two places, reads in one — and makes "where is `org_id` applied?" a question with two answers. The coverage test's value comes from there being exactly one path.
- **gRPC or tRPC between `web` and `api`.** Removes the schema-drift objection, not the hop, the extra deployment, or the shared-fate point. Adds a second RPC dialect next to the REST contract F3 already requires.
