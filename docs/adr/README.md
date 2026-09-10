# Architecture decision records

Format: context, decision, consequences, alternatives rejected. One file per decision. Superseding an ADR means a new file that references the old one; never edit a decided ADR's decision.

| # | Title | Status |
|---|---|---|
| 0001 | Runtime: k3s on Hetzner, portable Helm chart | decided; node type superseded by 0010 |
| 0002 | Ingress and edge: ingress-nginx, cert-manager, Cloudflare in front | decided |
| 0003 | Auth: Auth.js with Google and GitHub, users in our Postgres | decided; "Prisma adapter" clause superseded by 0018 |
| 0004 | Queue: pgmq in production, SQS adapter tested against LocalStack | decided |
| 0005 | Retrieval: pgvector hybrid search, in-process embeddings | decided |
| 0006 | LLM routing: OpenRouter primary, Bedrock adapter switch-proven | decided |
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
| 0018 | Tenancy data layer: Drizzle schema with RLS policies versioned together, `SECURITY DEFINER` entry-point resolvers, migrations via in-cluster `frontdesk-db-migrate` Job; amends 0003 and 0007 | decided; hook-phase clause superseded by 0019 |
| 0019 | `frontdesk-db-migrate` runs `post-install,pre-upgrade` (a `pre-install` hook deadlocks against the Postgres StatefulSet it needs); amends 0018 | decided |
| 0020 | deployer Role needs `patch` on `batch/jobs` (Helm 4 applies hooks server-side); Helm version pinned in CI; amends 0016 | decided, applied |
| 0021 | `web/` uses `@frontdesk/db` in-process; `api/` serves external integrations (F3) and owns the queue producer | decided |
