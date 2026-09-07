# Architecture decision records

Format: context, decision, consequences, alternatives rejected. One file per decision. Superseding an ADR means a new file that references the old one; never edit a decided ADR's decision.

| # | Title | Status |
|---|---|---|
| 0001 | Runtime: k3s on Hetzner, portable Helm chart | decided, amended 2026-09-07 (cax21 ARM64) |
| 0002 | Ingress and edge: ingress-nginx, cert-manager, Cloudflare in front | decided |
| 0003 | Auth: Auth.js with Google and GitHub, users in our Postgres | decided |
| 0004 | Queue: pgmq in production, SQS adapter tested against LocalStack | decided |
| 0005 | Retrieval: pgvector hybrid search, in-process embeddings | decided |
| 0006 | LLM routing: OpenRouter primary, Bedrock adapter switch-proven | decided |
| 0007 | Tenancy: two seeded orgs, org_id scoping plus RLS | decided |
| 0008 | AI-first SDLC: provenance, review agent, eval gate, ops loop | decided |
