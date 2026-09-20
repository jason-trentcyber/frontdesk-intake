# CLAUDE.md — context pack for agents working in this repo

frontdesk is an AI-assisted request desk for small businesses, built in public as an AI-first SDLC demonstration. The process is a deliverable: how you work here matters as much as what you ship.

## Read first, in this order

1. `REQUIREMENTS.md` — what we are building and the definition of done (§9).
2. `docs/AI-GOVERNANCE.md` — what you may and may not do. Non-negotiable.
3. `docs/conventions.md` — layout, toolchain, style, tests, PR rules.
4. The ADR(s) for the directory you are about to touch (map below). If your change contradicts an ADR, propose a superseding ADR in the same PR; do not silently diverge.

## ADR map by directory

| Path | Governing ADR(s) | Notes |
|---|---|---|
| `deploy/chart/` | 0001 runtime, 0002 ingress, 0010 sizing, 0014 deploy, 0015 values-file path + RBAC, 0016 postgres, 0017 consumer creds + config_file, 0018 migrate Job, 0019 migrate hook phase | One chart, one release; Postgres is a StatefulSet in it (`postgres.enabled`), image pinned by digest only in image-bump PRs; `values-hetzner.yaml`/`values-eks.yaml` live inside it (0015 supersedes ADR-0001's top-level path for these two files); k3s-agnostic otherwise; total requests < 2.8 GB; images by digest from GHCR |
| `deploy/bootstrap/`, `deploy/values-eks.yaml` (top-level) | 0001 runtime, 0002 ingress, 0010 sizing; `rbac/` also 0014, 0015, 0016, 0020 | Plain `helm upgrade --install` per chart, no Helmfile; requests <= 600 Mi; the top-level `values-eks.yaml` is the bootstrap ingress-nginx Service-type swap only, distinct from `deploy/chart/values-eks.yaml`; `rbac/deployer` Role's full verb list is in ADR-0015, extended by 0016 and 0020; the surface depends on the Helm major version, which `deploy.yml` pins |
| `deploy/postgres/` | 0016 postgres, 0017 consumer creds, 0004 queue, 0005 retrieval, 0007 tenancy | Dockerfile (pgvector base + pgmq SQL), initdb roles (`frontdesk` owner, `frontdesk_app` runtime, both `NOBYPASSRLS`), backup/restore runbook; image tag = content, never overwritten |
| `infra/hetzner/` | 0001, 0002, 0010, 0012, 0013 | Terraform, cloud-init k3s; 4 GB x86 node, observability off-node; local state, off-host copy; admin access over the tailnet |
| `infra/aws/` | 0001 | EKS root, validate-only, never applied in v1 |
| `infra/cloudflare/` | 0002 ingress, 0012 state | DNS/TLS-mode/WAF/rate-limit/Turnstile for `frontdesk.jtrent.dev` only; Free plan (1 rate-limit rule); local state, off-host copy |
| `web/` auth, sessions, membership | 0003 auth, 0007 tenancy, 0018 data layer, 0021 web/db boundary, 0030 Playwright, 0031 #26 auth design | PRs touching these get `security`; `@auth/drizzle-adapter`, database sessions, Auth.js tables in a dedicated `auth` schema (0031); tenant reads/writes only through `forOrg()` from `@frontdesk/db`, in-process - `web/` never proxies reads through `api/` (0021); membership re-resolved per request via `resolveMembership()`, never cached in the session/JWT/cookie; guard runs in `proxy.ts`, `/app/layout.tsx`, and every Server Action (0031); browser-driven tests use Playwright, not puppeteer (0030) |
| `web/` pages, public form, tracking | 0021 web/db boundary, 0017 consumer creds, 0027 #27 split, 0029 Lighthouse gate, 0033 Tailwind design system | `web/` reads via `@frontdesk/db` in-process, never through `api/` (0021); its DB credential follows ADR-0017's pattern (`APP_PGUSER` + `frontdesk-app-password`, `$(VAR)` expansion), never `frontdesk-password`. The public form's Server Action calls `api/`'s intake path pod-to-pod (`API_ORIGIN`, derived from the api Service, mirrors `PUBLIC_WEB_ORIGIN`) - never by leaving the cluster through the Ingress (0021). 27a shipped the boundary + `/t/<token>`; 27b ships `/r/<slug>`, the landing demo queue, and the Lighthouse accessibility gate (0027, 0029). Styling is Tailwind CSS v4 (`web/src/app/globals.css`, `@theme`/`@layer base`) - no component library, colors/spacing are Tailwind's own scale (0033) |
| `api/` queue producer | 0004 queue, 0021 web/db boundary, 0022 queue provisioning, 0023 message contract | `Queue` interface; pgmq + SQS adapters. `api/` is the ONLY enqueue implementation - `web/`'s form submits through it server-side (0021). The queue itself is created by `api/` at startup as `frontdesk_app`, not by a migration - the owner role has no `pgmq` privileges (0022) |
| `api/` any tenant query | 0007 tenancy, 0018 data layer, 0021 web/db boundary | `org_id` always; through `forOrg()` from `@frontdesk/db`, never a bare `db` on a tenant table. `api/`'s audience is external integrations (F3, F15), not our own UI (0021) |
| `db/` | 0018 data layer, 0019 migrate hook phase, 0007 tenancy, 0005 retrieval, 0016/0017 roles + creds | Drizzle schema (tables + `pgPolicy` in the same file), `drizzle-kit` migrations, resolvers, seeds, coverage test, `frontdesk-db` migrate image; every new tenant table = `org_id` + `.enableRLS()` + policy |
| `worker/llm/` | 0006 llm-routing, 0023 spend controls, 0024 grep-test scope | The ONLY place a provider is named; the four spend layers (vendor cap, per-org budget, global daily ceiling -> FakeProvider, `LLM_PROVIDER=fake`) are requirements, not options |
| `worker/` ingestion, retrieval | 0005 retrieval, 0023 worker runtime, 0025 ingestion trigger | bge-small, HNSW params, RRF; ONNX Runtime not torch; `asyncpg` + hand-written SQL, no Python ORM; tenant access only through `for_org()`, which mirrors `forOrg()` in `db/`; ingestion consumes `frontdesk_ingest`, embeds in batches of at most 32 (the size ADR-0023's 512Mi limit was measured at) |
| `docs/contracts/` | 0004 queue, 0023 worker runtime, 0025 ingest contract | Language-neutral message shapes. `triage-message.schema.json` and `ingest-message.schema.json` are validated by BOTH `api/`'s and `worker/`'s test suites - the queue has no RLS, so these files are what keep a producer bug from becoming a cross-tenant one |
| `worker/prompts/` | 0008 sdlc §7, 0005 | Every change runs the eval gate |
| `evals/` | 0008, 0036 | Replayed LLM fixtures, seed corpus, three zero-tolerance metrics; baseline only raised by an `agent:human` PR; prompt edits require a `--record` fixture diff |
| `.github/` | 0008, 0011, 0014, 0029, 0034 | Provenance, review agent, gates; Dependabot exempt; deploy.yml joins the tailnet, namespace-scoped kubeconfig; `lighthouse` job is blocking, per-PR, accessibility only (0029); `pages.yml` publishes `docs/diagrams/` and is deliberately outside `ci.yml` - it gates nothing (0034) |
| `compose.yaml` | 0028 loopback port bindings, 0004 queue, 0016 postgres image | Local dev only; never produces a shipped artifact. Every published port names an explicit bind address (`"127.0.0.1:5432:5432"`), never the short `"5432:5432"` form, which binds `0.0.0.0`. Off-host reachability is an ADR, not a compose edit. A host firewall is NOT a control here: Docker DNATs published ports through `FORWARD`, never `INPUT`, so a ufw rule reports success and enforces nothing (0028) |
| `docs/adr/` | `docs/adr/README.md` | Never edit a decided ADR's decision |
| `docs/diagrams/` | 0034 diagram publishing | Generated by the `archify` CLI from `architecture.json`, not hand-edited HTML. Changing the diagram means editing the JSON and re-running validate -> deliver -> visual-check, then re-exporting both PNGs; commands in `architecture-assumptions.md`. `*.visual-check.*` is evidence and is gitignored |

## Commands

```
make up            # Postgres (pgvector, pgmq) + LocalStack via $(CONTAINER)
make down
make lint          # eslint + prettier --check + ruff check + ruff format --check
make test          # vitest + pytest (FakeProvider, no network)
make eval          # evals/run.py against evals/golden, compares to baseline.json
pnpm eval:export --org <slug>   # staff edits/rejects -> evals/candidates/<slug>.jsonl (gitignored, curate by hand)
pnpm --filter web dev
pnpm --filter api dev
uv run --project worker python -m worker
```

`CONTAINER=podman make up` for Podman. Never run production images locally; CI builds them.

## Test expectations

- New behavior in `api/` or `worker/` ships with a test in the same PR. The review agent blocks otherwise.
- No test may call OpenRouter or AWS. Use `FakeProvider` and the pgmq/LocalStack service containers.
- Touching `worker/llm/` means `provider-parity` must stay green: identical normalized `Completion` across OpenRouter (recorded), Bedrock (botocore Stubber), Fake.
- Touching prompts, retrieval, or `evals/` means `make eval` must not drop classification accuracy, recall@5, or recall@1 below `evals/baseline.json` (ADR-0036). A prompt edit also needs a `make eval ARGS=--record` fixture diff in the PR.

## Things that always need a human (do not do these yourself)

- Anything that changes which org can see which data.
- Adding a third-party service or data processor.
- Changing `LLM_PROVIDER` in production values.
- Deleting data. Spending above the configured caps.
- Approving or merging a PR. Touching secrets or sealed-secret sources.

## Before you open a PR

- [ ] Branch is `claude/<topic>` (or `hermes/`, `jason/`).
- [ ] Exactly one label: `agent:claude-code` (or `agent:hermes`, `agent:human`). Add `model:budget` if a sub-Sonnet model drafted it; add `security` if you touched auth/tenancy/RLS/secrets.
- [ ] `Model:` line in the PR body is filled in.
- [ ] Linked issue. ADRs touched listed. Tests run listed.
- [ ] Keep `Co-Authored-By` trailers. Do not squash them away locally.
- [ ] `make lint && make test` green locally.

## Repo facts

- Repo: `github.com/jason-trentcyber/frontdesk-intake`, Apache-2.0, public. Site: `https://frontdesk.jtrent.dev`.
- Two seeded orgs: `bright-smile-dental` (public demo) and `harbor-legal` (private). All data fictional.
- Production LLM: Claude Haiku 4.5 via OpenRouter, $10/month cap. Bedrock adapter is switch-proven, not live.
- One k3s node on Hetzner (cx23, 4 GB, x86) at 167.233.178.242 (floating IP). Observability lives on the Hermes VPS, not the cluster (ADR-0010). Resource limits are mandatory in the chart.
