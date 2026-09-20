"""Unit tests for the eval harness's pure pieces (ADR-0036). The end-to-end
path (ingest -> classify -> retrieve -> gate) is exercised by the `eval` CI
job itself; these cover the logic that would fail silently there: the
replay key, anchor-section extraction, and metric arithmetic.

Lives in worker/tests/ because that is where pytest already runs with the
worker's dependencies on the path; pyproject's pytest `pythonpath` adds the
repo root so `evals` imports the same way `make eval` runs it.
"""

import json
from pathlib import Path

import pytest
from evals.recorded import RecordedProvider, UnrecordedPrompt, prompt_key, save_fixtures
from evals.run import HarnessError, Result, load_golden, metrics_of, section_first_blocks

from llm import Message


def test_load_golden_rejects_uncurated_candidate_lines(tmp_path: Path) -> None:
    # A line straight out of `pnpm eval:export` still carries `provenance`;
    # the harness must refuse it rather than score the model's own labels.
    good = {
        "id": "x-1",
        "subject": "s",
        "body": "b",
        "expected_category": "billing",
        "expected_urgency": "normal",
        "expected_chunk": None,
    }
    (tmp_path / "ok.jsonl").write_text(json.dumps(good) + "\n")
    assert len(load_golden(tmp_path)) == 1

    candidate = {**good, "id": "x-2", "provenance": {"action": "edit"}}
    (tmp_path / "ok.jsonl").write_text(json.dumps(candidate) + "\n")
    with pytest.raises(HarnessError, match="provenance"):
        load_golden(tmp_path)


def test_prompt_key_is_stable_and_sensitive_to_every_input() -> None:
    msgs = [Message(role="user", content="Subject: hi\n\nBody:\nhello")]
    base = prompt_key(msgs, max_tokens=200, temperature=0.0)
    assert base == prompt_key(msgs, max_tokens=200, temperature=0.0)
    assert base != prompt_key(msgs, max_tokens=201, temperature=0.0)
    assert base != prompt_key(msgs, max_tokens=200, temperature=0.1)
    assert base != prompt_key(
        [Message(role="user", content="Subject: hi\n\nBody:\nhello!")],
        max_tokens=200,
        temperature=0.0,
    )


async def test_recorded_provider_replays_and_refuses_unrecorded(tmp_path: Path) -> None:
    msgs = [Message(role="user", content="Subject: recorded\n\nBody:\nx")]
    key = prompt_key(msgs, max_tokens=200, temperature=0.0)
    path = tmp_path / "completions.json"
    save_fixtures(
        path,
        {
            key: {
                "subject": "recorded",
                "model": "m",
                "text": '{"category": "billing"}',
                "input_tokens": 3,
                "output_tokens": 2,
                "finish_reason": "stop",
            }
        },
    )
    provider = RecordedProvider(path)
    assert provider.size == 1

    completion = await provider.complete(msgs, max_tokens=200, temperature=0.0)
    assert completion.text == '{"category": "billing"}'
    assert completion.cost_usd == 0.0
    assert completion.provider == "recorded"

    other = [Message(role="user", content="Subject: never recorded\n\nBody:\nx")]
    with pytest.raises(UnrecordedPrompt, match="never recorded"):
        await provider.complete(other, max_tokens=200, temperature=0.0)


def test_section_first_blocks_matches_chunker_block_rules() -> None:
    md = (
        "# Title\n\nIntro paragraph.\nSecond line of intro.\n\n"
        "## Holidays\n\nClosed on holidays.\n\nSecond paragraph, not the anchor.\n\n"
        "## Empty\n\n## Emergencies\n\nCall the office."
    )
    sections = section_first_blocks(md)
    assert sections["Title"] == "Intro paragraph.\nSecond line of intro."
    assert sections["Holidays"] == "Closed on holidays."
    assert sections["Emergencies"] == "Call the office."
    assert "Empty" not in sections


def test_metrics_exclude_unanchored_examples_from_recall() -> None:
    def result(*, cat_ok: bool, chunk: str | None, top: list[str], expected: set[str]) -> Result:
        return Result(
            id="x",
            category="a" if cat_ok else "b",
            urgency="normal",
            expected_category="a",
            expected_urgency="normal",
            expected_chunk=chunk,
            top_ids=top,
            expected_ids=frozenset(expected),
        )

    results = [
        result(cat_ok=True, chunk="f.md#H", top=["c1", "c2"], expected={"c1"}),  # hit@1
        result(cat_ok=False, chunk="f.md#H", top=["c2", "c1"], expected={"c1"}),  # hit@5 only
        result(cat_ok=True, chunk="f.md#H", top=["c2"], expected={"c1"}),  # miss
        result(cat_ok=True, chunk=None, top=[], expected=set()),  # excluded from recall
    ]
    m = metrics_of(results)
    assert m["classification_accuracy"] == 0.75
    assert m["recall_at_5"] == round(2 / 3, 4)
    assert m["recall_at_1"] == round(1 / 3, 4)
    assert m["urgency_accuracy"] == 1.0
    # Every value is already at baseline precision, so a baseline written
    # from one run compares equal on the next.
    assert all(v == round(v, 4) for v in m.values())
    json.dumps(m)
