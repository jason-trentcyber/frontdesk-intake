# evals/candidates/

Output of `pnpm eval:export --org <slug>` (#31, F13): one JSONL file per org, one
line per staff **edit** or **reject** action, in the golden-set line shape plus a
`provenance` block (who did what, the model's draft, the human's reply or the
reject reason).

**Everything here except this README is gitignored, on purpose.** The public
`/r/<slug>` form accepts text from anyone, so a candidate line can contain a
stranger's words. Nothing in this directory reaches the repo without a human
reading it first.

## Curating a candidate into the golden set

1. Read the line. Decide the *correct* `expected_category` / `expected_urgency` -
   the exported values are the model's own and are not verified. Staff cannot
   relabel those in the UI; an edit or reject tells you the draft was wrong,
   not what the category should have been.
2. Set `expected_chunk` to the `<file>.md#<Heading>` a correct answer would
   cite, or leave `null` if nothing in the corpus answers it.
3. Give it a stable `id` (`dental-021`, not `candidate-<uuid>`).
4. **Delete the `provenance` block.** `evals/run.py` rejects any golden line
   that still carries it - a raw paste fails the gate loudly.
5. Append the line to `evals/golden/<vertical>.jsonl`, run
   `make eval ARGS=--record` once (the new prompt needs a recorded completion,
   ~$0.001), and commit the fixture diff with the golden line.

Raising `evals/baseline.json` afterwards is a separate `agent:human` PR
(ADR-0036 decision 5).
