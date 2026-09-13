"""F8: a confidence score recorded with every draft.

No golden dataset exists yet to calibrate a formula against (#30 - the eval
gate that would measure whether a formula like this one actually tracks
draft quality is exactly what that issue builds). So this is deliberately
built only from values the pipeline already computes during retrieval and
drafting, not a separately-trained or separately-tuned model:

    confidence = 0.6 * floor_margin + 0.4 * citation_coverage

- **floor_margin**: how far the *average* cosine similarity across every
  retrieved chunk sits above the similarity floor, normalized to [0, 1]
  against the remaining headroom to a perfect match (1.0). This is
  independent of which chunks the draft actually cited - it measures how
  well the request is grounded in the org's documents at all, which is a
  property of retrieval, not of the model's citation behavior.
- **citation_coverage**: the fraction of retrieved chunks the draft actually
  cited (valid citations only - invalid ones never reach this function,
  since draft.py escalates those to needs_human before confidence is ever
  computed). A proxy for how much of the available grounding the draft drew
  on.

Weighted 60/40 rather than evenly because citation_coverage rewards citing
*many* chunks, which is not the same as citing the *right* ones - a
precision-aware signal is exactly what an LLM-judged eval (#30, REQUIREMENTS
S4) should surface, and this formula should be revisited against that
measurement once it exists rather than tuned by guesswork now. Not written
up as an ADR: confidence is advisory display only (F11), read by staff
alongside the draft they are about to approve/edit/reject - it decides
nothing about tenancy, spend, or who sees what data, and is cheap to
recompute or reweight later without touching a stored decision.

drafts.confidence is numeric(4,3) - three decimal places, [0.000, 1.000]
already fits the range this function returns.
"""

SIMILARITY_FLOOR_WEIGHT = 0.6
CITATION_COVERAGE_WEIGHT = 0.4


def compute_confidence(
    retrieved_similarities: list[float],
    num_cited: int,
    num_retrieved: int,
    floor: float,
) -> float:
    if not retrieved_similarities or num_retrieved == 0:
        return 0.0

    avg_similarity = sum(retrieved_similarities) / len(retrieved_similarities)
    headroom = max(1e-9, 1.0 - floor)
    floor_margin = max(0.0, min(1.0, (avg_similarity - floor) / headroom))
    citation_coverage = max(0.0, min(1.0, num_cited / num_retrieved))

    confidence = (
        SIMILARITY_FLOOR_WEIGHT * floor_margin + CITATION_COVERAGE_WEIGHT * citation_coverage
    )
    return round(max(0.0, min(1.0, confidence)), 3)
