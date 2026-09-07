# AI governance for frontdesk

This repo is built with AI coding agents alongside a human. These are the rules. They apply to Claude Code in the IDE, Hermes and its subagents on the VPS, and any other agent that opens a PR.

## Who may do what

| Action | Human | Claude Code (IDE) | Hermes / subagents | Review agent | Ops agent |
|---|---|---|---|---|---|
| Write application code | yes | yes | yes | no | no |
| Open a PR | yes | yes | yes | no | no |
| Approve a PR | yes | no | no | no | no |
| Merge to `main` | yes | no | no | no | no |
| Edit Terraform, Helm, CI workflows | yes | yes, with ADR reference | yes, with ADR reference | no | no |
| Edit auth, tenancy scoping, RLS policies | yes | yes, PR flagged `security` | no | no | no |
| Touch secrets, tokens, sealed-secret sources | yes | no | no | no | no |
| Apply infra changes to the cluster | yes | no | no (CI does it on merge) | no | no |
| Read cluster state, logs, alerts | yes | no | read-only SA | no | read-only SA |
| Open issues | yes | yes | yes | no | yes |
| Change prompts or eval datasets | yes | yes | yes | no | no |

## Provenance

- Every PR has exactly one label: `agent:human`, `agent:claude-code`, or `agent:hermes`.
- The PR template includes a `Model:` line (e.g. `claude-sonnet-4.5`, `qwen2.5-coder-32b`). Fill it in.
- `Co-Authored-By` trailers added by tools stay in the commit. Do not squash them away.
- Cheap-model output (anything below Sonnet-class) never merges without the review agent passing AND a Claude-class or human review pass. Label such PRs `model:budget`.
- **Dependabot is the one exemption.** Its PRs carry no `agent:*` label, no `Model:` line, and get no review-agent pass; `pr-lint` and `review-agent` skip when the author is `dependabot[bot]`. The bot identity is the provenance — there is no model behind a version bump, and runs it triggers cannot read Actions secrets, so the review agent could not run even if we wanted it. Dependency PRs are gated by `ci` (`node`, `python`, `gitleaks`, `helm-lint`, `terraform-validate`) plus a human reading the changelog. Every other author, human or agent, fails without a label and a model.

## What agents must read first

Before editing an area, load its ADR. The context pack (`CLAUDE.md`, `AGENTS.md`) lists which ADR covers which directory. An agent that changes behavior an ADR covers must either follow it or propose a superseding ADR in the same PR.

## Secrets

- No secrets in the repo, ever. gitleaks runs in CI and blocks.
- Agents do not have access to production secrets. Local dev uses `.env.example` values and OpenRouter keys with a per-key spend cap.
- Agents must not paste secrets into prompts, issues, PR bodies, or logs. If one leaks, rotate first, then clean history.

## Human-required decisions

These always need a human, no matter what the agent thinks:
- Anything that changes who can see another org's data
- Adding a third-party service or data processor
- Changing the LLM provider in production
- Deleting data
- Spending money above the configured caps

## Review agent rubric

The review agent checks, in this order, and marks `blocking` where noted:
1. Secrets or credentials in the diff (blocking)
2. Tenant scoping: any query on a tenant table without `org_id` (blocking)
3. Tests present for new behavior (blocking for `api/`, `worker/`)
4. ADR compliance for the touched area
5. Prompt changes without an eval run
6. Obvious injection, SSRF, path traversal
7. Style and clarity, as suggestions only

## Ops agent

Runs on a schedule with a read-only service account and Loki query access. It may open issues with: the alert or log excerpt, a hypothesis, a proposed fix, and the confidence in that fix. It may not run `kubectl apply`, restart pods, or modify anything. Issues are labeled `agent:hermes` and `ops`.

## Evals

Prompt or retrieval changes must not lower recall@5 or classification accuracy below the baseline in `evals/baseline.json`. Raising the baseline requires a human to commit the new file.

## When an agent is wrong

Reject the PR with a reason. Rejections are training data for the context pack: if the same mistake repeats, add a rule to `docs/conventions.md`, not to a chat.
