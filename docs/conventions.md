# Conventions

Rules every contributor (human or agent) follows. If a PR is rejected for the same reason twice, the reason becomes a rule here (ADR-0008 §7).

## Repo layout

```
web/            Next.js app: landing, public form, tracking page, staff queue (Auth.js)
api/            Fastify service: request intake, org-scoped REST, queue producer
worker/         Python: triage pipeline, ingestion, LLM + queue adapters
  llm/          LLMProvider interface + OpenRouter / Bedrock / Fake adapters. ONLY place a provider is named.
  prompts/      Versioned prompt files + CHANGELOG.md
deploy/chart/   One Helm chart for everything; nothing k3s-specific
  values.yaml            k3s-agnostic defaults
  values-hetzner.yaml    live
  values-eks.yaml        the documented swap (never applied in v1)
  sealed/                SealedSecrets, applied by the same release; no plaintext, ever
deploy/bootstrap/            In-cluster bootstrap: ingress-nginx, cert-manager, sealed-secrets, observability
  rbac/                       namespace + least-privilege RBAC for CI deploys (ADR-0014), human-applied once
deploy/values-eks.yaml        bootstrap layer's own EKS swap (ingress-nginx Service type) - distinct from deploy/chart/values-eks.yaml
infra/hetzner/  Terraform: server, firewall, floating IP, cloud-init k3s
infra/aws/      Terraform: EKS root, validate-only
evals/          golden/*.jsonl, run.py, baseline.json
docs/           ADRs, governance, this file, review rubric
.github/        workflows, PR template, CODEOWNERS
```

The owning ADR for each directory is listed in `CLAUDE.md`. Read it before editing.

## Toolchain

- Node 22+, pnpm workspace (`web/`, `api/`). Python 3.12 with `uv` (`worker/`, `evals/`).
- Local runtime: **Docker or Podman, your choice.** The repo never assumes one:
  - `compose.yaml` uses Compose v2 spec syntax only.
  - Makefile targets use `$(CONTAINER)`; default `docker`, override with `CONTAINER=podman`.
  - Podman users: point the Docker socket at Podman instead of aliasing (`export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock`); aliases break tools that exec `docker` by absolute path. Set `TESTCONTAINERS_RYUK_DISABLED=true` if testcontainers are used. Containers reach the host at `host.containers.internal`, not `localhost`.
  - Production images are built only in GitHub Actions (BuildKit) and run on k3s/containerd. Your local runtime never produces a shipped artifact.
- Local services via compose: Postgres 16 with `pgvector` + `pgmq`, LocalStack (SQS only, for the adapter contract tests). Nothing else.

## Configuration

- All config by environment variables. `.env.example` is complete and committed; `.env` is git-ignored.
- Provider selection is env-only: `LLM_PROVIDER=openrouter|bedrock|fake`, `QUEUE_PROVIDER=pgmq|sqs`. No code outside the adapter packages may branch on these (ADR-0004, ADR-0006; a grep test enforces it for LLM).
- Model ids come from `worker/llm/models.yaml`, referenced by alias (`LLM_MODEL=haiku`).

## Data and tenancy (ADR-0007)

- Every tenant table has `org_id NOT NULL` + FK. No exceptions, no "global" convenience tables that later grow tenant data.
- Queries go through the Prisma middleware that injects `org_id`. Raw SQL on tenant tables must include `org_id` in the predicate and set `app.org_id` for RLS.
- Migrations are Prisma migrations, committed, forward-only. Never edit an applied migration.
- Seed data is fictional and obviously so. No real names, addresses, phone numbers.

## Code style

- TypeScript strict. ESLint + Prettier, config at root. No `any` without a comment saying why.
- Python: `ruff` (lint + format), `pyright` basic. Type hints on public functions.
- Structured JSON logs everywhere with `org_id` and `request_id` when available. No `console.log` / `print` in committed code.
- Errors: fail loudly at boundaries, never swallow. The API returns RFC 9457 problem details.

## Tests

- `api/` and `worker/`: new behavior needs a test in the same PR (the review agent blocks without one).
- Unit tests use `FakeProvider` and an in-memory or pgmq-backed queue; they never call OpenRouter.
- Contract tests run identically across adapters (`provider-parity` for LLM, the queue contract for pgmq/SQS).
- Prompt or retrieval changes run `evals/run.py`; recall@5 and classification accuracy may not drop below `evals/baseline.json`. Raising the baseline is a human commit.

## Git and PRs

- Branch names: `<agent>/<short-topic>` where agent is `jason`, `claude`, or `hermes`.
- Commits: imperative subject ≤ 72 chars. Keep tool-added `Co-Authored-By` trailers.
- Every PR: exactly one `agent:*` label, `Model:` line filled in the template, linked issue. PR-lint enforces the first two.
- `model:budget` label on anything drafted by a sub-Sonnet model. It needs the review agent green plus a Sonnet-class or human pass.
- Squash-merge to `main`. `main` is deploy-on-merge; never merge red.

## Secrets

- Never in the repo. gitleaks runs in CI. `.env`, `*.tfvars`, kubeconfigs are git-ignored.
- Local dev: an OpenRouter key with a spend cap. CI: repo secret `OPENROUTER_API_KEY` (the $5 CI key). Prod: sealed-secrets in the cluster.
- If a secret lands in a commit: rotate first, then clean history, then say so in the PR.

## Infra

- Terraform: `terraform fmt` + `validate` on both roots in CI. State backend is documented in `infra/hetzner/README.md`. Never `apply` from a laptop; CI applies on merge with a scoped token.
- Helm: `helm lint` in CI. Every container has resource requests and limits (8 GB node, ADR-0001). Images pinned by digest in values.
- Nothing in `deploy/chart/` may reference k3s, Hetzner, or Cloudflare by name; those belong in the values files.
