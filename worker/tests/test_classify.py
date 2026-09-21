import json
from dataclasses import dataclass, field

import pytest

from frontdesk_worker.triage.classify import (
    DEFAULT_CATEGORY,
    DEFAULT_URGENCY,
    classify_and_route,
    render_category_definitions,
)
from llm import Completion, Message
from llm.fake import FakeProvider

_CATEGORIES = ["scheduling", "billing", "other"]
_LANES = {"scheduling": "front-desk", "billing": "billing", "other": "front-desk"}


@dataclass
class ScriptedProvider:
    """Test double implementing the LLMProvider protocol structurally -
    same pattern as the codebase's other Fake*/test doubles (FakeQueue,
    etc.), not a mock of worker/llm/ itself.
    """

    text: str
    input_tokens: int = 10
    output_tokens: int = 5
    model: str = "test-model"
    calls: list[list[Message]] = field(default_factory=list)

    async def complete(
        self, messages: list[Message], *, tools: object = None, max_tokens: int, temperature: float
    ) -> Completion:
        self.calls.append(messages)
        return Completion(
            text=self.text,
            input_tokens=self.input_tokens,
            output_tokens=self.output_tokens,
            finish_reason="stop",
            cost_usd=0.0,
            provider="test",
            model=self.model,
        )


async def test_valid_json_response_is_parsed() -> None:
    provider = ScriptedProvider(
        text=json.dumps({"category": "billing", "urgency": "high", "summary": "wants a refund"})
    )

    result = await classify_and_route(
        provider, _CATEGORIES, _LANES, "Refund?", "I want my money back"
    )

    assert result.category == "billing"
    assert result.urgency == "high"
    assert result.summary == "wants a refund"
    assert result.lane == "billing"
    assert result.model == "test-model"
    assert result.input_tokens == 10
    assert result.output_tokens == 5


@pytest.mark.parametrize(
    "fenced",
    [
        '```json\n{"category": "billing", "urgency": "high", "summary": "wants a refund"}\n```',
        '```\n{"category": "billing", "urgency": "high", "summary": "wants a refund"}\n```',
        '  ```json\n{"category": "billing", "urgency": "high", "summary": "wants a refund"}\n```  \n',
    ],
)
async def test_fenced_json_response_is_parsed(fenced: str) -> None:
    # #133: the real provider returns the object wrapped in a Markdown code
    # fence despite the prompt. The first shape is verbatim from
    # evals/fixtures/completions.json; the others are tolerated variants.
    provider = ScriptedProvider(text=fenced)

    result = await classify_and_route(
        provider, _CATEGORIES, _LANES, "Refund?", "I want my money back"
    )

    assert result.category == "billing"
    assert result.urgency == "high"
    assert result.summary == "wants a refund"


def test_render_category_definitions_one_line_per_category_in_org_order() -> None:
    # #152: the org's descriptions become the definition block the model
    # reads; a category with no description is still listed (bare) so the
    # label set stays complete; a description for an unconfigured category
    # is ignored.
    rendered = render_category_definitions(
        ["billing", "scheduling", "other"],
        {
            "scheduling": "Booking or moving an appointment.",
            "billing": "  Invoices. ",
            "ghost": "x",
        },
    )

    assert (
        rendered == "- billing: Invoices.\n- scheduling: Booking or moving an appointment.\n- other"
    )


def test_render_category_definitions_without_descriptions_or_categories() -> None:
    assert render_category_definitions(["a", "b"], None) == "- a\n- b"
    assert render_category_definitions([], None) == f"- {DEFAULT_CATEGORY}"


async def test_descriptions_are_rendered_into_the_prompt() -> None:
    provider = ScriptedProvider(
        text=json.dumps({"category": "billing", "urgency": "normal", "summary": "s"})
    )

    await classify_and_route(
        provider,
        _CATEGORIES,
        _LANES,
        "subject",
        "body",
        category_descriptions={"billing": "Invoices and payments."},
    )

    prompt = provider.calls[0][0].content
    assert "- billing: Invoices and payments." in prompt
    assert "- scheduling\n" in prompt


async def test_route_assigns_lane_from_category() -> None:
    provider = ScriptedProvider(
        text=json.dumps(
            {"category": "scheduling", "urgency": "low", "summary": "wants an appointment"}
        )
    )

    result = await classify_and_route(provider, _CATEGORIES, _LANES, "Booking", "body")

    assert result.lane == "front-desk"


@pytest.mark.parametrize(
    "text",
    [
        "not json at all",
        json.dumps({"category": "billing"}),  # missing urgency/summary
        json.dumps({"category": "not-a-real-category", "urgency": "low", "summary": "x"}),
        json.dumps({"category": "billing", "urgency": "not-a-real-urgency", "summary": "x"}),
        json.dumps({"category": "billing", "urgency": "low", "summary": ""}),
        json.dumps(["billing", "low", "x"]),  # valid JSON, wrong shape
    ],
)
async def test_malformed_or_invalid_response_falls_back_to_safe_defaults(text: str) -> None:
    provider = ScriptedProvider(text=text)

    result = await classify_and_route(provider, _CATEGORIES, _LANES, "subject", "body")

    assert result.category == DEFAULT_CATEGORY
    assert result.urgency == DEFAULT_URGENCY
    assert result.summary


async def test_route_falls_back_to_some_lane_when_default_category_has_none() -> None:
    provider = ScriptedProvider(text="not json")
    lanes_without_other = {"scheduling": "front-desk"}

    result = await classify_and_route(
        provider, ["scheduling", "other"], lanes_without_other, "s", "b"
    )

    # DEFAULT_CATEGORY ("other") has no lane of its own here - falls back to
    # *some* configured lane rather than leaving routing null.
    assert result.lane == "front-desk"


async def test_graceful_with_the_real_fake_provider() -> None:
    """LLM_PROVIDER=fake (ADR-0023 §5 layer 4, or a global-ceiling downgrade,
    layer 3) must never crash classification - FakeProvider's echoed,
    non-JSON text is exactly the input _parse() has to degrade gracefully
    on, not a hypothetical.
    """
    provider = FakeProvider(model_alias="haiku")

    result = await classify_and_route(provider, _CATEGORIES, _LANES, "subject", "body text")

    assert result.category == DEFAULT_CATEGORY
    assert result.urgency == DEFAULT_URGENCY
    assert result.lane
    assert result.model == "haiku"
