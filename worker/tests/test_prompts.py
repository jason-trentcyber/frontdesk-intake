from pathlib import Path

from frontdesk_worker.triage.prompts import CLASSIFY_TEMPLATE, DRAFT_TEMPLATE, PROMPT_VERSION

_CHANGELOG_PATH = Path(__file__).resolve().parents[1] / "prompts" / "CHANGELOG.md"


def test_classify_template_has_the_expected_placeholders() -> None:
    rendered = CLASSIFY_TEMPLATE.format(categories="a, b", subject="s", body="b")
    assert "a, b" in rendered
    assert "s" in rendered


def test_draft_template_has_the_expected_placeholders() -> None:
    rendered = DRAFT_TEMPLATE.format(subject="s", body="b", chunks="[c:1] text")
    assert "[c:1] text" in rendered


def test_prompt_version_is_named_in_the_changelog() -> None:
    """S7 / this PR's own constraint: drafts.prompt_version must match what
    worker/prompts/CHANGELOG.md names - a version bump to one without the
    other is exactly the drift this test exists to catch.
    """
    changelog = _CHANGELOG_PATH.read_text()
    assert f"## {PROMPT_VERSION}" in changelog
