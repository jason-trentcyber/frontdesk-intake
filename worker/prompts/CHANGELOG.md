# Prompt changelog

Every prompt file under `worker/prompts/` is versioned here (S7 — REQUIREMENTS.md
§5). A prompt change is a PR like any other and runs the eval gate (ADR-0036):
the replay fixtures in `evals/fixtures/completions.json` are keyed on the
rendered prompt, so editing a prompt invalidates them and the PR must include
a `make eval ARGS=--record` re-record (human-run, ~$0.01) and its fixture diff.

`drafts.prompt_version` records which entry below produced a given draft.

## triage-v2 (2026-09-21, #152)

`classify.md` only. Found by the live demo: "bad toothache, do I need to come
in today?" classified `other` / `normal`. The v1 prompt handed the model the
bare label list and the word "urgency" with no definition of either.

- **Category definitions.** A new `{category_definitions}` block renders one
  `- <category>: <description>` line per configured category from the org's
  `settings.categoryDescriptions` (`db/src/settings.ts`; seeded from
  `db/seed/<org>/settings.json`). Categories are per-org, so the definitions
  live in org settings next to the `lanes` map, not in this file. A category
  without a description is listed bare; `{categories}` is unchanged.
- **Urgency rubric.** `high` / `normal` / `low` are now defined in the prompt
  (pain, injury, bleeding, swelling, safety, or "do I need to be seen today"
  = high). v1 said only "how time-sensitive the request is".
- Fixtures re-recorded (`make eval ARGS=--record`, 24 completions against
  `anthropic/claude-haiku-4.5` via OpenRouter, $0.017); golden set extended
  with high-urgency clinical examples (`evals/golden/dental.jsonl`,
  dental-021..024 - the live toothache verbatim plus three neighbours;
  `high` examples go from 1 to 4).
- `make eval` on this head, replayed from the re-recorded fixtures, against
  the unchanged `evals/baseline.json`:

  | metric                  | value | baseline | status        |
  | ----------------------- | ----- | -------- | ------------- |
  | classification_accuracy | 1.000 | 1.000    | ok            |
  | recall_at_5             | 1.000 | 1.000    | ok            |
  | recall_at_1             | 0.900 | 0.889    | ok            |
  | urgency_accuracy        | 0.833 | -        | reported only |

  All four new high-urgency clinical examples classify `clinical-question` /
  `high`. The four urgency misses (dental-002, -003, -014, -018) are
  arguable labels on the original set, not rubric failures; urgency stays
  reported-only until it is promoted with a reviewed set (#152 follow-up).

## triage-v1 (2026-09-13, #25)

Initial classify + draft prompts for the triage pipeline
(`frontdesk_worker/triage/`).

- `classify.md` — category (from the org's configured set) / urgency
  (low/normal/high) / one-line summary, as a single JSON object. A response
  that fails to parse, or names a category/urgency the org didn't configure,
  is not retried — the pipeline falls back to a safe default (`other` /
  `normal`) so a malformed or fake (`LLM_PROVIDER=fake`, ADR-0023 §5) response
  never crashes triage; see `frontdesk_worker/triage/classify.py`.
- `draft.md` — a cited reply generated only from retrieved chunks, plain text
  with inline `[c:<chunk id>]` citations (not JSON). A citation naming an id
  that was not retrieved is rejected and the draft is regenerated once with a
  corrective reminder; if it still fails, the request is escalated to
  `needs_human` rather than publishing an unverifiable citation. See
  `frontdesk_worker/triage/draft.py`.

Both prompts are formatted with `str.format()` from the org's own subject/body
text and, for `draft.md`, the retrieved chunk text — there is no templating
engine in between, so the file *is* the prompt.
