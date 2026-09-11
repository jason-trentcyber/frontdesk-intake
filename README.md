# frontdesk

An AI-assisted request desk for small businesses, built in public as an **AI-first SDLC** demonstration.

Customers submit requests through a public form. The system classifies each request, routes it to a lane, retrieves the business's own documents, and drafts a cited reply. Staff approve, edit, or reject. The engineering *process* (agents and humans on one repo, with guardrails from ideation to operations) is as much the deliverable as the product.

**Status:** Milestone 1 (skeleton and SDLC scaffolding). Nothing deployed yet.

Live site: `https://frontdesk.jtrent.dev` (not yet) · Board: [github.com/users/jason-trentcyber/projects/1](https://github.com/users/jason-trentcyber/projects/1) · Docs: [`REQUIREMENTS.md`](REQUIREMENTS.md), [`docs/adr/`](docs/adr/README.md), [`docs/AI-GOVERNANCE.md`](docs/AI-GOVERNANCE.md)

## Architecture

_Diagram pending (M2)._ Short version: Next.js web + Fastify API + Python worker on one Helm chart, k3s on a single Hetzner node, Postgres 16 with pgvector (retrieval) and pgmq (queue), Cloudflare at the edge, OpenRouter for the LLM with a switch-proven Bedrock adapter. Decisions and rejected alternatives are in the ADRs.

## The AI-first SDLC story

Six guardrails, all visible in this repo:

1. **Context pack** — `CLAUDE.md`, `AGENTS.md`, `docs/conventions.md`, ADRs. Agents read before they write.
2. **Provenance** — every PR has one `agent:*` label and a `Model:` line; co-author trailers are kept. Enforced by `pr-lint`.
3. **Blocking review agent** — Claude Code headless reviews every PR against `docs/review-rubric.md`; `blocking` findings fail the check. A human still approves.
4. **Eval gate** — prompt and retrieval changes must not regress `evals/baseline.json`.
5. **Governance** — `docs/AI-GOVERNANCE.md`: who may do what, what always needs a human.
6. **Ops loop** — a scheduled agent with read-only cluster access files issues with evidence. It never applies changes.

## Cost

_Table pending (M4, #43): OpenRouter vs Bedrock vs Hetzner GPU vs Ollama at the sized workload, with break-even._

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
