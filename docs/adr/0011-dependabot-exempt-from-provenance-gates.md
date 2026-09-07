# ADR-0011: Dependabot PRs are exempt from the provenance and review-agent gates

Status: decided 2026-09-07. Amends step 3 of ADR-0008's decision (review and provenance gates) for bot-authored dependency PRs only. ADR-0008 otherwise stands.

## Context
ADR-0008 step 3 requires two things of every PR: a blocking `review-agent` pass, and provenance (exactly one `agent:*` label plus a filled-in `Model:` line) enforced by `pr-lint`. The ADR was written when every PR came from Jason, Claude Code, or a Hermes subagent. Dependabot was enabled later, in #12, and filed its first batch on 2026-09-07: PRs #44–#49 (github-script 9, checkout 7, setup-node 7, eslint 10, typescript 6, vitest 5).

All six failed both gates, for reasons unrelated to the dependency changes:

- `pr-lint` reported `No "agent:*" label found` and `No "Model:" line found`. Dependabot does not read the PR template and cannot be made to; it has no `agent:*` identity in the taxonomy and there is no model behind a version bump.
- `review-agent` failed with an empty `ANTHROPIC_API_KEY`. The run log shows `Secret source: Dependabot`: workflow runs triggered by `dependabot[bot]` are scoped to the *Dependabot* secret store, not Actions secrets. This is GitHub's behaviour, not a misconfiguration in this repo — the same secret resolves correctly on human- and agent-authored PRs (verified on #51).

Neither cause can be fixed by anything Dependabot does differently. Left alone, every dependency PR for the life of the project shows two red checks next to five green ones, and the habit that forms is merging over red. That is a worse outcome for the SDLC thesis than a narrower gate.

The five non-vitest PRs pass every substantive check: `node` (lint, typecheck, unit), `python` (ruff, pytest), `gitleaks`, `helm-lint`, and both `terraform-validate` jobs. #49 (vitest 5) fails `node` for a real reason — `ERR_PACKAGE_PATH_NOT_EXPORTED`, changed exports in vitest 5 — which is exactly the signal the gates are supposed to surface, and it survives this change.

## Decision
- `pr-lint` and the `review-agent` gate job skip when the PR author is `dependabot[bot]`. The check is on author identity (`github.event.pull_request.user.login`), not on a label, so it cannot be claimed by a human or an agent.
- Bot identity is the provenance for these PRs. The commit author, the branch prefix (`dependabot/`), and the diff shape are all machine-attested and none of them are author-controlled in the way a label is.
- Dependency PRs are gated by the `ci` workflow — `node`, `python`, `gitleaks`, `helm-lint`, `terraform-validate` — plus a human reading the changelog before merging. The human gate of ADR-0008 is unchanged: no dependency PR merges itself.
- The `ANTHROPIC_API_KEY` is **not** duplicated into the Dependabot secret store. That would make the review agent run, at roughly $0.70 per PR, to review a lockfile SHA bump, and would widen the blast radius of a production credential to a second store for no review value.
- Every other author, human or agent, still fails `pr-lint` without a label and a model, and still gets a blocking review-agent pass. This is the only exemption; if a second one is ever proposed, it needs its own ADR.

## Consequences
- Dependency PRs go fully green or fully red on substance. A red dependency PR now means the dependency actually broke something.
- Provenance for dependency changes is attested by author identity rather than by a label. Anyone auditing the repo's provenance story reads the `dependabot/*` branch prefix and the bot author instead of an `agent:*` label; `docs/AI-GOVERNANCE.md` → Provenance states this explicitly so it is discoverable without reading workflow YAML.
- The review agent never sees dependency diffs. Accepted risk: a malicious upstream release would not be caught by the review agent, but it would not have been caught by an LLM reading a lockfile SHA either. `gitleaks` still runs, and the real mitigations are SHA-pinned actions (already the convention in `ci.yml`), the pnpm lockfile, and reading the changelog.
- If Dependabot is ever configured to open PRs that touch application code (it is not today — `dependabot.yml` covers github-actions, npm, and uv manifests only), this exemption should be revisited, because the assumption "the diff is a version bump" is what makes it safe.

## Rejected
- **Duplicate `ANTHROPIC_API_KEY` into the Dependabot secret store.** Makes the gate technically pass, spends ~$0.70 per PR reviewing SHA bumps, and puts a production credential in a second store. Cost with no review value.
- **Add `ignore: version-update:semver-major` to `dependabot.yml`** so fewer PRs are filed. Reduces the symptom by reducing dependency PRs, which is the wrong direction — the majors are worth taking now, while the tree is still scaffolding, rather than on top of real application code.
- **Exempt by label (`dependencies`) instead of by author.** Dependabot applies that label, but so can a human. Author identity is not forgeable through the UI.
- **Have Hermes or Claude Code retitle and relabel each Dependabot PR** to satisfy `pr-lint`. Makes the provenance line a lie — it would claim a model wrote a diff no model wrote — and turns a weekly bot batch into manual agent work.
- **Drop `pr-lint` and `review-agent` entirely.** They are two of the six guardrails that are the point of the project (ADR-0008). The narrow carve-out keeps both gates meaningful for the PRs where a model actually wrote the code.
