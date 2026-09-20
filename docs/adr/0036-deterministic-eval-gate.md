# ADR-0036: the deterministic eval gate - replayed LLM, seed corpus, human-only baseline

Status: decided 2026-09-20 (#126). Implements the eval-gate step of ADR-0008 and discharges ADR-0023 §3's standing "eval gate unavailable" obligation. The LLM-judged draft-quality score stays in #30 and is out of scope here.

## Context

The gate was specified in three places (REQUIREMENTS S4, ADR-0008 step 4, ADR-0023 §3) and implemented in none. `make eval` printed "not implemented", `evals/golden/` was empty, and `docs/review-rubric.md` item 5 accepted "the gate does not exist" as sufficient evidence on every prompt and retrieval PR. Every worker PR since #25 carried that exception.

The design constraint is cost. This is the one CI check specific to this being an AI product, and it must run on every PR without spending money: ADR-0023 §cost puts 60 live classify calls at $0.32 per run, which at the repo's PR volume is real spend for a gate that is supposed to be free to run often.

Two things measured while building it change the shape from the #126 brief:

1. **The seed corpus is four one-chunk documents.** Every file under `db/seed/bright-smile-dental/` is 190-232 bge tokens, under the chunker's 400-token target, so the whole corpus is four chunks. Retrieval returns top-5. Recall@5 over four candidates can only miss when the right chunk falls below the 0.35 similarity floor; it is a tautology at this corpus size and would sit at 1.0 through most regressions.
2. **The classifier's JSON parse fails on the real provider.** The first `--record` run against the configured model returned every completion wrapped in a ` ```json ` fence despite the prompt's instruction not to. `classify.py:_parse` does a bare `json.loads`, so every example degraded to `other` and classification accuracy measured **0.20** (the four `other` examples, by accident). Production runs `LLM_PROVIDER=fake`, so nothing had ever exercised this path.

## Decision

1. **Replay, don't spend.** `evals/recorded.py` implements `llm.LLMProvider` from `evals/fixtures/completions.json`, keyed on a SHA-256 of the rendered messages plus `max_tokens` and `temperature`. An unrecorded key raises `UnrecordedPrompt` - a hard failure, never a silent skip. `evals/run.py --record` wraps a real provider (selected by `LLM_PROVIDER`, credential read inside `worker/llm/` per ADR-0006) and rewrites the fixture file; it is human-run and refuses `fake`. The CI job sets no `LLM_PROVIDER` and no credential, and asserts so before running.

   **What this does and does not catch.** A replayed gate catches prompt, parsing, routing, chunking, embedding, and retrieval regressions. It does not catch a model regression: if the provider's behaviour changes, the fixtures do not know. A prompt edit changes every key, forcing a deliberate re-record whose diff is reviewed in the PR - that is the intended mechanism for the one class of change that must re-consult the model. The measured record cost is $0.0088 for 20 examples.

2. **The seed corpus is the eval corpus.** `run.py` inserts `db/seed/bright-smile-dental/*.md` as documents in a throwaway org (`eval-<random>`), ingests them through `frontdesk_worker.ingestion.pipeline` under `for_org()` exactly as production does, scores, and deletes the org. No parallel fixture corpus: the gate measures the shipped demo. Editing a seed doc can move a metric, which is a change the gate should see.

3. **Three gated metrics, zero tolerance.** `classification_accuracy` (exact match on category), `recall_at_5` (the S4 metric), and `recall_at_1` (added because of the corpus-size finding above - rank-1 is what moves when RRF, chunking, or the embedder change). `run.py` exits 1 if any is strictly below `evals/baseline.json`, at four decimal places. No tolerance band: every metric is deterministic (replayed completions, ONNX on CPU), so any drop is a real change. If ONNX float drift ever flakes a ranking, add tolerance then with the failing run as evidence, not preemptively. `urgency_accuracy` is reported and not gated (label noise on a 3-way ordinal).

4. **Anchors are `<file>.md#<Heading>`, resolved at run time.** An example's `expected_chunk` names a seed file and a heading; the harness resolves it to whichever chunk ids contain that section's first paragraph. The golden set survives re-chunking. An anchor that resolves to nothing is a harness error (exit 2), not a miss - a mislabeled example must not be scored.

5. **The baseline is human-only, enforced by `pr-lint`, not by CODEOWNERS review.** `.github/CODEOWNERS` names `evals/baseline.json` for intent. GitHub only enforces CODEOWNERS through "require review from code owners", and a single maintainer cannot approve their own PR, so enabling that would block the human too. The enforceable proxy is provenance: `pr-lint` fails any PR that *modifies* `evals/baseline.json` without the `agent:human` label. Creating the file is exempt (the first baseline is the measured value of what the harness PR ships). This is the same reasoning the ruleset already uses for zero required approvals: on a single-maintainer repo, "human review" means the human opening or merging the PR.

6. **`eval` is its own always-run required check.** Not a step in `python`, so a regression reads as "eval failed" in the checks list. Not path-filtered: a path-filtered required check never reports on unrelated PRs and blocks them forever. It is `.github/rulesets/main.json`'s 16th required context.

7. **The first baseline is committed at the measured, degraded value.** `classification_accuracy: 0.2`, `recall_at_5: 1.0`, `recall_at_1: 0.8889`. The parse bug is #133; its fix PR raises the baseline to what the same 20 recorded completions score once fences are stripped (1.0 category, measured offline). One issue per PR, and the gate's first catch is on record in two linked PRs rather than fixed silently inside the PR that built it.

## Rejected

- **A hand-written eval corpus under `evals/fixtures/docs/`** (the #126 brief). A second corpus drifts from the demo and measures something nobody ships.
- **Live provider calls in CI with a budget.** Non-deterministic, costs money on every PR, and needs a secret in a job that runs on fork PRs.
- **`FakeProvider` as the replay.** It returns `[fake completion for: ...]`, which fails JSON parse; every example would classify as `other`. Replay has to be real recorded output.
- **CODEOWNERS with code-owner review required.** Blocks the only human. See decision 5.
- **A tolerance band.** See decision 3.
- **Path-filtering the job to `worker/**`, `evals/**`.** See decision 6.
- **Fixing the parse bug inside this PR.** See decision 7.

## Consequences

- `docs/review-rubric.md` item 5's "gate unavailable" exception is removed. A prompt or retrieval PR needs the `eval` check green, or a fixture re-record whose diff is in the PR.
- `worker/prompts/CHANGELOG.md`'s standing note about the gate not existing is replaced.
- A prompt change now costs a re-record (~$0.01 at 20 examples, run by a human with a real key). That is a feature: the fixture diff shows exactly what the model said before and after.
- #31 (staff edits/rejections exported as labeled examples) grows the golden set from real corrections; the harness reads every `evals/golden/*.jsonl`, so new files need no code change. Once the corpus has more chunks than the top-5 window, recall@5 starts to discriminate on its own.
- The ruleset must be re-applied after this merges (`gh api -X PUT .../rulesets/23715051 --input .github/rulesets/main.json`, per `docs/AI-GOVERNANCE.md`), or the `eval` context is not required.
