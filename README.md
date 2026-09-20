# frontdesk

An AI-assisted request desk for small businesses, built in public as an **AI-first SDLC** demonstration.

Customers submit requests through a public form. The system classifies each request, routes it to a lane, retrieves the business's own documents, and drafts a cited reply. Staff approve, edit, or reject. The engineering *process* (agents and humans on one repo, with guardrails from ideation to operations) is as much the deliverable as the product.

**Status:** deployed and serving on a single k3s node. Public intake, tracking, and staff sign-in work end to end. The staff queue is read-only for now — request detail, citations, and approve/edit/reject are [#26](https://github.com/jason-trentcyber/frontdesk-intake/issues/26). Two of the six SDLC guardrails below are specified but not built yet; each says so.

**Live:** [frontdesk.jtrent.dev](https://frontdesk.jtrent.dev) · Board: [projects/1](https://github.com/users/jason-trentcyber/projects/1) · Docs: [`REQUIREMENTS.md`](REQUIREMENTS.md), [`docs/adr/`](docs/adr/README.md), [`docs/AI-GOVERNANCE.md`](docs/AI-GOVERNANCE.md)

### Try it

| Surface | What it is |
|---|---|
| [`/`](https://frontdesk.jtrent.dev) | Landing page |
| [`/r/bright-smile-dental`](https://frontdesk.jtrent.dev/r/bright-smile-dental) | Public request form for the demo org — submit one and you get a tracking link |
| `/t/<token>` | Tracking page for a submitted request; unguessable token, no login |
| [`/app`](https://frontdesk.jtrent.dev/app) | Staff queue — redirects to sign-in; membership is re-resolved per request, never cached in the session |

Demo submissions are purged after 24 hours. The demo org's retrieval index is inspectable without auth: [`/api/v1/orgs/bright-smile-dental/index-info`](https://frontdesk.jtrent.dev/api/v1/orgs/bright-smile-dental/index-info) returns the embedding model, chunking strategy, HNSW parameters, and live document/chunk counts. Non-demo orgs 404 there by design — it never confirms a private org's slug is real.

## Architecture

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/diagrams/architecture-dark.png">
  <img alt="frontdesk system architecture: browser and API clients enter through Cloudflare and ingress-nginx into a single-node k3s cluster running web (Next.js), api (Fastify), a Python worker and Postgres with pgvector and pgmq; GitHub Actions deploys over the tailnet and Prometheus scrapes the node from off-host." src="docs/diagrams/architecture-light.png">
</picture>

**[Open the interactive version](https://jason-trentcyber.github.io/frontdesk-intake/architecture.html)** — pan, zoom, search, trace a relationship, or step through four guided views (request path, triage pipeline, switch-proof adapters, delivery and operations).

Next.js web + Fastify API + Python worker on one Helm chart, k3s on a single Hetzner node, Postgres 16 with pgvector (retrieval) and pgmq (queue), Cloudflare at the edge, OpenRouter for the LLM with a switch-proven Bedrock adapter. Decisions and rejected alternatives are in the ADRs; what the diagram asserts and where it simplifies is in [`docs/diagrams/architecture-assumptions.md`](docs/diagrams/architecture-assumptions.md).

## The AI-first SDLC story

Six guardrails, all visible in this repo:

1. **Context pack** — `CLAUDE.md`, `AGENTS.md`, `docs/conventions.md`, ADRs. Agents read before they write.
2. **Provenance** — every PR has one `agent:*` label and a `Model:` line; co-author trailers are kept. Enforced by `pr-lint`.
3. **Blocking review agent** — Claude Code headless reviews every PR against `docs/review-rubric.md`; `blocking` findings fail the check. A human still approves.
4. **Eval gate** — `evals/run.py` runs 20 labeled requests through the shipped classifier and retrieval against the demo corpus, with LLM completions replayed from recorded fixtures so CI spends nothing (ADR-0036). Three metrics — classification accuracy, recall@5, recall@1 — may not drop below `evals/baseline.json`; the `eval` check is required on every PR, and the baseline is only raised by a human-labeled PR. Its first run measured a classifier parse bug (accuracy 0.20) that production had never exercised.
5. **Governance** — `docs/AI-GOVERNANCE.md`: who may do what, what always needs a human.
6. **Ops loop** — *specified, not built ([#32](https://github.com/jason-trentcyber/frontdesk-intake/issues/32)).* The design: a scheduled agent with read-only cluster access files issues with evidence and never applies changes. It depends on off-node Prometheus/Loki ([#52](https://github.com/jason-trentcyber/frontdesk-intake/issues/52)), which is also not built.

## Cost

_Table pending ([#33](https://github.com/jason-trentcyber/frontdesk-intake/issues/33)): OpenRouter vs Bedrock vs Hetzner GPU vs Ollama at the sized workload, with break-even._

## Switch to Bedrock

1. Set `LLM_PROVIDER=bedrock` in the worker's values (never as a live edit — CLAUDE.md).
2. Set `AWS_REGION` to the target region.
3. Supply AWS credentials — IRSA in EKS, or `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env elsewhere.
4. `LLM_MODEL` stays the same alias; `worker/llm/models.yaml` resolves it to the Bedrock model id.
5. Redeploy. `worker/llm/`'s `provider-parity` CI job already proves both adapters produce an identical normalized `Completion` for the same input.

## Run locally

Requires Node 22+, pnpm, Python 3.12, uv, and Docker **or** Podman. See `docs/conventions.md` → Toolchain.

```
git clone https://github.com/jason-trentcyber/frontdesk-intake.git
cd frontdesk-intake
cp .env.example .env
make up               # postgres (pgvector + pgmq) + localstack
pnpm install
cd worker && uv sync && cd ..
make test
```

Podman instead of Docker: prefix every `make` target with `CONTAINER=podman`, e.g. `CONTAINER=podman make up`.

## Caveats

Single node, no HA (Hetzner cx23, 4 GB). Metrics and logs ship to a separate monitoring host rather than running Prometheus/Loki on the node (ADR-0010). This is a demo with a real production posture, not a production service. No PHI, no real personal data; seed data is fictional and demo submissions are purged after 24 hours.

## License

Apache-2.0.
