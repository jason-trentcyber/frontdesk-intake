# Architecture decision records

Format: context, decision, consequences, alternatives rejected. One file per decision. Superseding an ADR means a new file that references the old one; never edit a decided ADR's decision.

| # | Title | Status |
|---|---|---|
| 0001 | Runtime: k3s on Hetzner, portable Helm chart | decided; node type superseded by 0010 |
| 0002 | Ingress and edge: ingress-nginx, cert-manager, Cloudflare in front | decided |
| 0003 | Auth: Auth.js with Google and GitHub, users in our Postgres | decided; "Prisma adapter" clause superseded by 0018; session-storage + table-location decisions made by 0031 |
| 0004 | Queue: pgmq in production, SQS adapter tested against LocalStack | decided; second queue (`frontdesk_ingest`) added by 0025 |
| 0005 | Retrieval: pgvector hybrid search, in-process embeddings | decided; embedding runtime (not the model) changed to ONNX by 0023; `reindex` image and embedding batch size fixed by 0025 |
| 0006 | LLM routing: OpenRouter primary, Bedrock adapter switch-proven | decided; grep-test scope narrowed by 0024 |
| 0007 | Tenancy: two seeded orgs, org_id scoping plus RLS | decided; "Prisma middleware" clause superseded by 0018 |
| 0008 | AI-first SDLC: provenance, review agent, eval gate, ops loop | decided; provenance/review gates amended by 0011 for Dependabot |
| 0009 | Node: Hetzner cax21 ARM64 | superseded by 0010, never applied |
| 0010 | Node: Hetzner cx23 (4 GB); observability off-node on the VPS | decided, applied |
| 0011 | Dependabot PRs exempt from the provenance and review-agent gates | decided |
| 0012 | Terraform state stays local with an off-host copy; no remote backend yet | decided |
| 0013 | Admin access to the node over the tailnet; VPS IP kept as break-glass on 22/6443 | decided, applied |
| 0014 | CI deploys over the tailnet (OAuth client, tag:ci); namespace-scoped SA kubeconfig; GHCR by digest; push not pull | decided |
| 0015 | App-chart values overlays live at `deploy/chart/values-*.yaml`; full RBAC surface for the ADR-0014 deployer Role | decided; RBAC list extended by 0016 |
| 0016 | Postgres: StatefulSet in the app chart, one pgvector+pgmq image for local and prod, nightly `pg_dump` to a PVC pulled to the VPS; no operator, no bucket | decided; consumer-secrets and config-include clauses superseded by 0017, `batch/jobs` verb list by 0020 |
| 0017 | Consumer credentials = ConfigMap + per-audience `secretKeyRef`; Postgres config as full `config_file`; amends 0016 | decided |
| 0018 | Tenancy data layer: Drizzle schema with RLS policies versioned together, `SECURITY DEFINER` entry-point resolvers, migrations via in-cluster `frontdesk-db-migrate` Job; amends 0003 and 0007 | decided; hook-phase clause superseded by 0019, `reindex`-image clause by 0025, "unscoped surface" sentence amended by 0031 |
| 0019 | `frontdesk-db-migrate` runs `post-install,pre-upgrade` (a `pre-install` hook deadlocks against the Postgres StatefulSet it needs); amends 0018 | decided |
| 0020 | deployer Role needs `patch` on `batch/jobs` (Helm 4 applies hooks server-side); Helm version pinned in CI; amends 0016 | decided, applied |
| 0021 | `web/` uses `@frontdesk/db` in-process; `api/` serves external integrations (F3) and owns the queue producer | decided |
| 0022 | `api/` creates the pgmq queue at startup as `frontdesk_app` (the owner role has no `pgmq` privileges, by design); amends 0004 and 0018 | decided |
| 0023 | Worker runtime: `asyncpg` and hand-written SQL (no Python ORM), a JSON-Schema queue contract both languages validate, ONNX Runtime embeddings, one process, four spend controls; amends 0004, 0005 and 0006 | decided |
| 0024 | The provider-isolation grep test bans LLM provider names in `worker/frontdesk_worker/` only — not `boto3` (ADR-0004's SQS SDK) and not test files; amends 0006 | decided |
| 0025 | Ingestion is triggered by its own `frontdesk_ingest` queue and contract; `documents.status` is the state machine; #24 ingests seeded documents only (upload is a separate issue); embedding batches capped at 32; `reindex` runs from the worker image; amends 0004, 0005 and 0018 | decided |
| 0026 | Observability on the VPS ships as Prometheus + Grafana only (node-exporter over the tailnet, no public bind, provisioned read-only dashboards); Loki and Alertmanager deferred on measured VPS memory; narrows #52 | decided, applied |
| 0027 | #27 splits: 27a wires `web/` to Postgres via `@frontdesk/db` + ADR-0017's credential pattern and ships `/t/<token>`; 27b ships the public form, landing demo queue and the Lighthouse gate; reaffirms 0021, narrows #27 | decided |
| 0028 | compose publishes every port on `127.0.0.1` explicitly; a host firewall is not a control for a Docker-published port (DNAT bypasses ufw's `INPUT` chain) — incident 2026-09-13 | decided, applied |
| 0029 | Lighthouse accessibility gate: a new `lighthouse` CI job, blocking, per-PR, plain `lighthouse` CLI (not `@lhci/cli`) against a real `next build`/`next start`, auditing `/` and `/r/<demo-slug>` only | decided |
| 0030 | Browser automation for tests: Playwright replaces puppeteer-core/chrome-launcher; ADR-0029's Lighthouse decision unchanged | decided |
| 0031 | #26 auth design: database sessions via `@auth/drizzle-adapter`, Auth.js tables in a dedicated `auth` Postgres schema, membership re-resolved per request (never cached), three-layer authorization guard (`proxy.ts`, `/app/layout.tsx`, every Server Action); amends 0003 and 0018 | decided; `AUTH_TRUST_HOST` consequence superseded by 0032 |
| 0032 | `AUTH_URL` (derived from `ingress.host`) replaces `AUTH_TRUST_HOST=true` in web's Deployment env - the latter didn't fix the production wrong-origin bug and is redundant once `AUTH_URL` is set; amends 0031 | decided |
| 0033 | Tailwind CSS v4 (official Next.js PostCSS integration) is `web/`'s styling stack; no component library; colors/spacing are Tailwind's own scale, not a bespoke token system | decided; root-layout clause amended by 0035 |
| 0034 | The architecture diagram is committed under `docs/diagrams/` and published to GitHub Pages; the README embeds a PNG pair, not SVG; the app does not serve it | decided, applied |
| 0035 | Page chrome (header/footer) in `web/`'s root layout: wordmark header, footer stating the human-approval step, flex column pinning the footer on short pages; amends 0033 | decided |
| 0036 | Deterministic eval gate: LLM replayed from recorded fixtures (zero CI spend), seed corpus ingested into a throwaway org, three zero-tolerance metrics (classification accuracy, recall@5, recall@1), baseline raised only by an `agent:human` PR via `pr-lint`, `eval` an always-run required check; implements 0008's gate step | decided, applied |
