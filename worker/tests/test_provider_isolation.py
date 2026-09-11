"""ADR-0006's provider-isolation grep test, scoped by ADR-0024.

Banned strings: 'openrouter', 'bedrock'. Scope: frontdesk_worker/ (the
runtime application package) only - not llm/ (the adapters, which must name
providers), not tests/ (which must name providers to test them).

'boto3' is deliberately NOT banned: ADR-0004 independently requires it for
the SQS adapter, an unrelated service. Full reasoning, including the
alternatives rejected, is in docs/adr/0024-provider-isolation-scope.md - not
repeated here, so the two cannot drift.
"""

from pathlib import Path

_WORKER_ROOT = Path(__file__).resolve().parents[1]
_SCOPE = _WORKER_ROOT / "frontdesk_worker"
_FORBIDDEN = ("openrouter", "bedrock")


def _source_files() -> list[Path]:
    return [
        path
        for path in _SCOPE.rglob("*.py")
        if not any(part in {"__pycache__"} for part in path.parts)
    ]


def test_no_provider_names_outside_llm() -> None:
    violations: list[str] = []
    for path in _source_files():
        text = path.read_text().lower()
        for term in _FORBIDDEN:
            if term in text:
                violations.append(f"{path.relative_to(_WORKER_ROOT)}: contains {term!r}")

    assert violations == [], "\n".join(violations)
