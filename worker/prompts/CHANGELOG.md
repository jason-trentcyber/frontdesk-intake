# Prompt changelog

Every prompt file under `worker/prompts/` is versioned here (S7 — REQUIREMENTS.md
§5). A prompt change is a PR like any other and (per `docs/review-rubric.md`)
triggers the eval gate once `evals/baseline.json` exists (#30). Until then, per
ADR-0023 §3's standing obligation, a PR touching these files says plainly in
its body that the gate was unavailable rather than fabricating a recall@5 or
accuracy number.

`drafts.prompt_version` records which entry below produced a given draft.

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
