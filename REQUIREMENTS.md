# frontdesk — Requirements v1

Status: approved for build, 2026-09-07. Decisions recorded from grill session; see `docs/adr/`.
Owner: Jason Trent. Build partners: Claude Code (IDE), Hermes (VPS: board, subagents, review, ops loop).

## 1. What it is

frontdesk is an AI-assisted request desk for small businesses. Customers submit requests through a public form; the system classifies each request, routes it to a lane, and drafts a reply grounded in the business's own documents. Staff review the draft, then approve, edit, or reject it.

Two purposes, one codebase:
1. Portfolio deliverable for the Slalom Senior Software Architect, AI Accelerated Engineering role (job 3471). The engineering PROCESS is a first-class deliverable, visible in the public repo.
2. First product of the Trent Cyber Advisory AI-assistant service line for SMBs.

Repo: `github.com/jason-trentcyber/frontdesk-intake`, Apache-2.0, public.
Site: `https://frontdesk.jtrent.dev`.

## 2. Roles

| Role | Auth | Can |
|---|---|---|
| Requester (customer of an org) | none | submit a request on `/r/<org-slug>`, view its status on `/t/<token>` |
| Staff (employee of an org) | OAuth (Google, GitHub), allow-listed to one org | see the org queue, read drafts and citations, approve / edit / reject |
| Owner | as staff | plus upload and remove documents, manage the staff allow-list |
| Visitor (recruiter, anyone) | none | landing page, read-only view of the demo org's queue, submit a request to the demo org |

## 3. Tenancy

- Two seeded orgs: `bright-smile-dental` (dental practice, public demo) and `harbor-legal` (small law office, private). Different documents, different lanes, so isolation is demonstrable.
- No self-serve org creation in v1. Staff accounts are mapped to an org by an allow-list in the database, edited by the owner or by seed.
- Every tenant-scoped table carries `org_id`. The API enforces scoping in a single Prisma middleware; no query path bypasses it. Postgres row-level security is enabled on tenant tables as a second layer.
- Per-org daily LLM budget (tokens), configurable; exceeding it queues requests without drafting and raises an alert.

## 4. Functional requirements

### 4.1 Request intake
- F1. Public form per org at `/r/<slug>`: name (optional), email (optional), subject, body. Cloudflare Turnstile required. Per-IP rate limit at ingress (10/min).
- F2. On submit, requester receives a tracking URL `/t/<token>` showing status and, once approved, the reply. No email is sent in v1.
- F3. REST endpoint `POST /api/v1/orgs/<slug>/requests` with the same payload, API-key authenticated, for integrations.

### 4.2 Triage pipeline (Python worker)
- F4. Classify: category (from the org's configured set, e.g. scheduling / billing / insurance / clinical-question / other), urgency (low / normal / high), and a one-line summary.
- F5. Route: assign a lane from category via org config.
- F6. Retrieve: hybrid search over the org's document chunks (pgvector cosine + Postgres full-text, reciprocal rank fusion), top-k with a similarity floor.
- F7. Draft: generate a reply using only retrieved chunks; every factual claim must cite a chunk id. If retrieval returns nothing above the floor, the draft says so and the request is flagged `needs-human`.
- F8. Confidence: the worker records a confidence score and the retrieved chunk ids with the draft.
- F9. Pipeline is asynchronous. API enqueues, worker consumes, results written back; the UI polls or subscribes. Target: draft visible within 10 s at p95 for the demo org.

### 4.3 Staff queue
- F10. Queue view per org: lane, urgency, age, status. Filter by lane and status.
- F11. Request detail: original text, classification, draft, citations rendered as expandable source snippets, confidence.
- F12. Actions: approve (reply becomes visible on the tracking page), edit then approve, reject with a reason. Every action is audit-logged (who, when, before/after).
- F13. Rejections and edits are exported to the eval dataset as labeled examples.

### 4.4 Documents
- F14. Owner uploads Markdown, plain text, or PDF (text layer only) per org. Files are chunked, embedded, and indexed asynchronously. Re-upload replaces.
- F15. Chunking strategy, embedding model, and index parameters are documented in ADR-0005 and exposed in `/api/v1/orgs/<slug>/index-info` for the demo.

### 4.5 Landing page
- F16. Explains the product in one screen, shows the demo org's form and a read-only live queue side by side, links to the repo, the board, and the docs.
- F17. Demo org seed data is obviously fictional. Live submissions to the demo org are purged after 24 hours by a scheduled job.

## 5. AI-first SDLC requirements (the differentiator)

- S1. Context pack in repo: `CLAUDE.md`, `AGENTS.md`, `docs/adr/`, `docs/conventions.md`, and skill files agents must load. Agents are instructed to read ADRs before touching the areas they cover.
- S2. PR provenance: every PR carries exactly one `agent:*` label (`agent:claude-code`, `agent:hermes`, `agent:human`) and a model tag in the PR body template. Co-author trailers from AI tools are kept, never stripped.
- S3. Review agent: a GitHub Action running Claude Code headless against the PR diff with a fixed rubric (security, tenancy scoping, secrets, tests present, ADR compliance). Findings marked `blocking` fail the check. Human approval still required to merge.
- S4. Eval gate: `evals/` holds a golden dataset (request → expected category, expected cited doc, rubric-scored draft). CI runs the eval on every PR touching `worker/`, `evals/`, or prompts. Retrieval recall@5 and classification accuracy may not drop below the recorded baseline; drafts are LLM-judged and reported, not blocking in v1.
- S5. Governance: `docs/AI-GOVERNANCE.md` states what agents may and may not do, what needs a human, secrets rules, and the provenance rules above.
- S6. Ops loop: a scheduled Hermes job with read-only cluster and Loki access reviews alerts and error logs, and opens a GitHub issue with evidence and a proposed fix labeled `agent:hermes` + `ops`. It never applies changes.
- S7. Prompts are versioned files under `worker/prompts/` with a changelog; a prompt change is a PR like any other and triggers S4.
- S8. Model routing: one `LLMProvider` interface, three adapters (OpenRouter, Bedrock, a deterministic fake for tests). Provider is selected by `LLM_PROVIDER` env only. See ADR-0006 and the switch-proof requirement in §7.

## 6. Non-functional

- N1. Runtime: k3s on a dedicated Hetzner Cloud box provisioned by Terraform (hcloud). Nothing k3s-specific in the Helm chart; `values-eks.yaml` documents the swap (ingress class, storage class, IRSA). Traefik disabled, ingress-nginx + cert-manager used.
- N2. Cloudflare in front: DNS, proxy, TLS, WAF managed rules, rate limiting, Turnstile. No Workers in v1.
- N3. Observability: kube-prometheus-stack, Loki, OpenTelemetry collector. Every service emits traces and structured JSON logs with `org_id` and `request_id`. Dashboards: request pipeline latency, LLM tokens per org, eval scores over time.
- N4. Security: least-privilege service accounts, network policies between namespaces, secrets via sealed-secrets, no secrets in the repo (gitleaks in CI), dependency scanning, container images pinned by digest.
- N5. CI: lint, typecheck, unit, integration (Postgres + LocalStack SQS service containers), eval gate, image build, Helm lint. Deploy on merge to `main` via GitHub Actions to the cluster.
- N6. Cost ceiling: OpenRouter hard cap $10/month; Hetzner box ~€8/month; Cloudflare free tier.
- N7. Data: no PHI, no real personal data. Seed data fictional. Demo submissions purged daily.

## 7. Switch-proof for the Bedrock adapter

"Flip of a switch" is a claim; this is the proof.
- P1. Contract test suite runs identically against all three adapters using botocore `Stubber` for Bedrock and recorded HTTP fixtures for OpenRouter. Same inputs, asserted-equal normalized outputs (text, token counts, finish reason, cost estimate).
- P2. `LLM_PROVIDER=bedrock` plus standard AWS env vars is the entire change. `values-eks.yaml` sets it. No code path branches on provider outside the adapter package.
- P3. README has a 5-line "switch to Bedrock" section and a CI job named `provider-parity` that must pass on every PR.
- P4. Same pattern for the queue: `QUEUE_PROVIDER=pgmq|sqs`, SQS adapter tested against LocalStack in CI.

## 8. Out of scope for v1

Jason amends this list; nothing here is built without an ADR.
- Self-service org creation and signup
- Inbound email (Cloudflare Email Routing) and outbound email (SES/Resend)
- Billing and plans
- Mobile
- AKS variant (EKS values file only)
- SOC 2 evidence collection
- Cloudflare Workers
- Self-hosting documentation for third parties
- Live Ollama route (adapter interface allows it; not shipped)
- Live AWS account (Bedrock and SQS adapters ship tested but unwired)

## 9. Definition of done, v1

- Public repo with README, context pack, governance doc, ADRs, board.
- `frontdesk.jtrent.dev` serving the landing page over TLS; demo org accepts a request and shows a cited draft in the read-only queue.
- Staff login works for at least one allow-listed account per org.
- All CI gates green on `main`, including `provider-parity` and the eval gate.
- Ops loop has filed at least one real issue from a real alert.
