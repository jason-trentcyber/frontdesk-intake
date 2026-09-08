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
| `deploy/chart/`, `deploy/values-*.yaml` | 0001 runtime, 0002 ingress, 0010 sizing | Chart stays k3s-agnostic; total requests < 2.8 GB |
| `infra/hetzner/` | 0001, 0002, 0010, 0012 | Terraform, cloud-init k3s; 4 GB x86 node, observability off-node; local state, off-host copy |
| `infra/aws/` | 0001 | EKS root, validate-only, never applied in v1 |
| `web/` auth, sessions, membership | 0003 auth, 0007 tenancy | PRs touching these get `security` |
| `api/` queue producer | 0004 queue | `Queue` interface; pgmq + SQS adapters |
| `api/` any tenant query | 0007 tenancy | `org_id` always; Prisma middleware |
| `worker/llm/` | 0006 llm-routing | The ONLY place a provider is named |
| `worker/` ingestion, retrieval | 0005 retrieval | bge-small, HNSW params, RRF |
| `worker/prompts/` | 0008 sdlc §7, 0005 | Every change runs the eval gate |
| `evals/` | 0008 | Baseline only raised by a human commit |
| `.github/` | 0008, 0011 | Provenance, review agent, gates; Dependabot exempt |
| `docs/adr/` | `docs/adr/README.md` | Never edit a decided ADR's decision |

## Commands

```
make up            # Postgres (pgvector, pgmq) + LocalStack via $(CONTAINER)
make down
make lint          # eslint + prettier + ruff + pyright
make test          # vitest + pytest (FakeProvider, no network)
make eval          # evals/run.py against evals/golden, compares to baseline.json
pnpm --filter web dev
pnpm --filter api dev
uv run --project worker python -m worker
```

`CONTAINER=podman make up` for Podman. Never run production images locally; CI builds them.

## Test expectations

- New behavior in `api/` or `worker/` ships with a test in the same PR. The review agent blocks otherwise.
- No test may call OpenRouter or AWS. Use `FakeProvider` and the pgmq/LocalStack service containers.
- Touching `worker/llm/` means `provider-parity` must stay green: identical normalized `Completion` across OpenRouter (recorded), Bedrock (botocore Stubber), Fake.
- Touching prompts, retrieval, or `evals/` means `make eval` must not drop recall@5 or classification accuracy below `evals/baseline.json`.

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
