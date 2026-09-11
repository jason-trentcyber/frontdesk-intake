"""ADR-0006: no file outside worker/llm/ may reference 'openrouter' or
'bedrock' - a grep test enforces it. The ADR itself now records that this
has always meant application code, not the tests that exercise the
adapters - see its "Switch-proof" section.

Scope: frontdesk_worker/ (the runtime package) only, not tests/ and not
llm/ itself. The brief's own wording ("this file itself and the ADRs are
prose - scope the test to source files") is about not tripping on
documentation; it doesn't (and can't) mean test files that specifically
exercise the provider adapters - test_llm_openrouter.py, test_llm_bedrock.py,
test_provider_parity.py, and this file's own docstring all have to name a
provider to test or describe it. What ADR-0006 actually protects is
*application* code outside llm/ branching on a provider, which
frontdesk_worker/ is - the same distinction api/'s equivalent comment draws
for @aws-sdk/client-sqs: production code reaching for a vendor SDK behind
the Queue interface is the violation, a test fixture that sets one up is not.

'boto3' is deliberately NOT part of this grep either, for the reason given
in queue/sqs.py's header comment: it's also the SDK ADR-0004 requires for
the SQS adapter, unrelated to which LLM provider is live.
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
