from frontdesk_worker.triage.confidence import compute_confidence


def test_perfect_similarity_and_full_citation_coverage_is_near_one() -> None:
    confidence = compute_confidence([1.0, 1.0], num_cited=2, num_retrieved=2, floor=0.35)

    assert confidence == 1.0


def test_similarity_at_the_floor_with_no_citations_is_zero() -> None:
    confidence = compute_confidence([0.35, 0.35], num_cited=0, num_retrieved=2, floor=0.35)

    assert confidence == 0.0


def test_no_retrieved_chunks_is_zero() -> None:
    assert compute_confidence([], num_cited=0, num_retrieved=0, floor=0.35) == 0.0


def test_partial_citation_coverage_scales_the_coverage_term() -> None:
    # avg similarity 1.0 -> floor_margin = 1.0 -> 0.6 contribution.
    # 1 of 2 cited -> coverage 0.5 -> 0.4 * 0.5 = 0.2 contribution.
    confidence = compute_confidence([1.0, 1.0], num_cited=1, num_retrieved=2, floor=0.35)

    assert confidence == 0.8


def test_citing_more_than_retrieved_is_clamped_not_amplified() -> None:
    # Defensive: cited ids are always a subset of retrieved in practice
    # (draft.py validates this before confidence is ever computed), but the
    # formula itself must not reward an inconsistent count > 1.0 coverage.
    confidence = compute_confidence([1.0], num_cited=5, num_retrieved=1, floor=0.35)

    assert confidence == 1.0


def test_similarity_below_the_floor_is_clamped_to_zero_margin() -> None:
    # Defensive: retrieve_chunks() already filters by the floor, so this
    # should not occur in practice, but the formula must not go negative.
    confidence = compute_confidence([0.1], num_cited=0, num_retrieved=1, floor=0.35)

    assert confidence == 0.0


def test_result_fits_drafts_confidence_numeric_precision() -> None:
    confidence = compute_confidence([0.42, 0.5, 0.61], num_cited=2, num_retrieved=3, floor=0.35)

    # numeric(4,3): exactly three decimal places.
    assert round(confidence, 3) == confidence
    assert 0.0 <= confidence <= 1.0
