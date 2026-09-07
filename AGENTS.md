# AGENTS.md

Instructions for any AI coding agent (Codex, OpenCode, Qwen, Hermes subagents) working in this repository. Claude Code reads `CLAUDE.md`; the content is the same, this file is the vendor-neutral copy plus provenance rules.

## Start here

Read in order: `REQUIREMENTS.md`, `docs/AI-GOVERNANCE.md`, `docs/conventions.md`, then the ADR for the directory you will edit. The directory-to-ADR map, commands, and test expectations are in `CLAUDE.md`; do not duplicate them, follow them.

## Provenance (required, enforced by CI)

- Your PR carries exactly one label: `agent:claude-code`, `agent:hermes`, or `agent:human`. Hermes subagents use `agent:hermes`. Other CLI agents driven by Jason use `agent:claude-code` only if Claude Code was the driver; otherwise `agent:human` with the tool named in the body.
- Fill the `Model:` line in the PR template with the actual model id (e.g. `claude-sonnet-4.5`, `qwen2.5-coder-32b`).
- If the model is below Sonnet-class, add `model:budget`. That PR cannot merge without the review agent passing and a Sonnet-class or human review.
- Never strip `Co-Authored-By` trailers.

## Scope of work by agent class (from `docs/AI-GOVERNANCE.md`)

- Budget models: CRUD handlers, tests from spec, Dockerfiles, Helm values, docs formatting, golden dataset drafting.
- Sonnet-class: architecture, ADRs, auth, tenancy, IAM, Terraform, review.
- No agent: approve, merge, apply infra, touch secrets, change who sees another org's data.

## Working rules

- One issue per PR. Reference it. Small diffs beat large ones.
- If the issue's acceptance criteria are ambiguous, ask in the issue, do not guess.
- If you find yourself naming `openrouter`, `bedrock`, or `boto3` outside `worker/llm/`, stop; that is a design violation (ADR-0006).
- Every query on a tenant table includes `org_id`. No exceptions (ADR-0007).
- Do not add dependencies, services, or containers without an ADR reference in the PR.
- Do not commit generated lockfile churn unrelated to your change.
- Leave the repo runnable: `make lint && make test` green before you open the PR.

## When you disagree with an ADR

Open the PR with a new ADR file `docs/adr/NNNN-<slug>.md` that supersedes the old one and explains why. Never edit the decision text of a decided ADR.
