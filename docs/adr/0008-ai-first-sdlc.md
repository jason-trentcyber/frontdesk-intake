# ADR-0008: AI-first SDLC mechanics

Status: decided 2026-09-07. Step 3's provenance and review-agent gates are amended by ADR-0011 for Dependabot-authored PRs (2026-09-07); everything else stands.

## Decision
Ideation → build → review → verify → operate, each with an agent touchpoint and a human gate.

1. Ideation: GitHub Projects board (public, read-only). Hermes drafts issues with acceptance criteria from REQUIREMENTS.md; Jason edits and prioritizes.
2. Build: Jason in VS Code with Claude Code on the NucBox; Hermes subagents on the VPS take parallelizable issues. Both open PRs against `main`. Context pack (`CLAUDE.md`, `AGENTS.md`, `docs/conventions.md`, ADRs) is the shared brief.
3. Review: `review-agent.yml` runs Claude Code headless with `docs/review-rubric.md`; blocking findings fail the check. Human approval required. Provenance labels and model tag required by a PR-lint check.
4. Verify: CI runs lint, typecheck, unit, integration (Postgres + LocalStack), `provider-parity`, eval gate (`evals/run.py` against `evals/golden/*.jsonl`, compares to `evals/baseline.json`), gitleaks, Helm lint, Terraform validate.
5. Deploy: merge to `main` builds images (digest-pinned) and runs `helm upgrade` against the cluster via a GitHub Actions deploy job with a scoped kubeconfig.
6. Operate: `ops-agent` cron (Hermes) with read-only SA and Loki access reviews alerts every 6 h, opens issues with evidence and a proposed fix. Never mutates.
7. Learn: PR rejections that repeat become rules in `docs/conventions.md`. Staff edits/rejections in the product become eval examples.

## Model split
- Claude Sonnet-class: architecture, ADRs, auth/tenancy/IAM/Terraform, review.
- Budget models (Qwen-class via OpenRouter): CRUD handlers, tests from spec, Dockerfiles, Helm values, docs formatting, golden dataset drafting. Label `model:budget`; never merges without the review agent plus a Sonnet-class or human pass.

## Rejected
- Fully autonomous merge: the human gate is the point.
- Stripping AI co-author trailers: contradicts the thesis.
