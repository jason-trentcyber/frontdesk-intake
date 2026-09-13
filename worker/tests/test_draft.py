from dataclasses import dataclass, field

from frontdesk_worker.triage.draft import generate_draft
from frontdesk_worker.triage.retrieve import RetrievedChunk
from llm import Completion, Message
from llm.fake import FakeProvider

_CHUNKS = [
    RetrievedChunk(id="c1", text="Cleanings are every six months.", similarity=0.9),
    RetrievedChunk(id="c2", text="Fillings take 20-30 minutes.", similarity=0.8),
]


@dataclass
class ScriptedProvider:
    """Same test-double shape as test_classify.py's - returns each entry in
    `responses` in order, one per call, so a test can script a retry.
    """

    responses: list[str]
    model: str = "test-model"
    calls: list[str] = field(default_factory=list)
    _index: int = 0

    async def complete(
        self, messages: list[Message], *, tools: object = None, max_tokens: int, temperature: float
    ) -> Completion:
        prompt = messages[0].content
        self.calls.append(prompt)
        text = self.responses[min(self._index, len(self.responses) - 1)]
        self._index += 1
        return Completion(
            text=text,
            input_tokens=10,
            output_tokens=5,
            finish_reason="stop",
            cost_usd=0.0,
            provider="test",
            model=self.model,
        )


async def test_valid_citation_is_accepted_on_the_first_attempt() -> None:
    provider = ScriptedProvider(responses=["Cleanings are every six months. [c:c1]"])

    outcome = await generate_draft(provider, "subject", "body", _CHUNKS)

    assert outcome.result is not None
    assert outcome.result.cited_ids == ["c1"]
    assert outcome.input_tokens == 10
    assert outcome.output_tokens == 5
    assert len(provider.calls) == 1


async def test_zero_citations_is_trivially_valid() -> None:
    provider = ScriptedProvider(responses=["I'm not sure I can help with that."])

    outcome = await generate_draft(provider, "subject", "body", _CHUNKS)

    assert outcome.result is not None
    assert outcome.result.cited_ids == []


async def test_multiple_distinct_valid_citations_are_all_captured() -> None:
    provider = ScriptedProvider(responses=["See [c:c1] and also [c:c2]."])

    outcome = await generate_draft(provider, "subject", "body", _CHUNKS)

    assert outcome.result is not None
    assert outcome.result.cited_ids == ["c1", "c2"]


async def test_invalid_citation_is_retried_once_with_a_corrective_reminder() -> None:
    provider = ScriptedProvider(
        responses=[
            "According to [c:not-a-real-id], cleanings are frequent.",
            "Cleanings are every six months. [c:c1]",
        ]
    )

    outcome = await generate_draft(provider, "subject", "body", _CHUNKS)

    assert outcome.result is not None
    assert outcome.result.cited_ids == ["c1"]
    assert len(provider.calls) == 2
    # The retry prompt must actually mention the valid ids as a corrective.
    assert "c1" in provider.calls[1]
    assert "c2" in provider.calls[1]
    # Tokens from BOTH attempts are real spend and must both be counted.
    assert outcome.input_tokens == 20
    assert outcome.output_tokens == 10


async def test_invalid_citation_on_both_attempts_returns_no_result_but_keeps_token_totals() -> None:
    provider = ScriptedProvider(
        responses=[
            "According to [c:bad-1], ...",
            "Still citing [c:bad-2], ...",
        ]
    )

    outcome = await generate_draft(provider, "subject", "body", _CHUNKS)

    assert outcome.result is None
    assert len(provider.calls) == 2
    assert outcome.input_tokens == 20
    assert outcome.output_tokens == 10


async def test_graceful_with_the_real_fake_provider() -> None:
    """FakeProvider never emits a [c:...] citation, so it always passes
    validation trivially (zero citations) on the first attempt - the
    killswitch/ceiling-downgrade path (ADR-0023 §5) must not trigger the
    retry-then-needs_human path just because the fake text isn't grounded.
    """
    provider = FakeProvider(model_alias="haiku")

    outcome = await generate_draft(provider, "subject", "body", _CHUNKS)

    assert outcome.result is not None
    assert outcome.result.cited_ids == []
