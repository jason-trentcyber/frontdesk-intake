"""Recorded-fixture test (respx) - no network, no API key (ADR-0006's
switch-proof).
"""

import httpx
import respx

from llm import Message
from llm.openrouter import OpenRouterProvider

_FIXTURE_RESPONSE = {
    "choices": [
        {
            "message": {"role": "assistant", "content": "Hello! How can I help?"},
            "finish_reason": "stop",
        }
    ],
    "usage": {"prompt_tokens": 12, "completion_tokens": 6},
}


@respx.mock
async def test_complete_parses_the_recorded_response() -> None:
    route = respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
        return_value=httpx.Response(200, json=_FIXTURE_RESPONSE)
    )
    provider = OpenRouterProvider(api_key="test-key", model_alias="haiku")

    completion = await provider.complete(
        [Message(role="user", content="hi")], max_tokens=100, temperature=0.0
    )

    assert route.called
    request_body = route.calls[0].request.content
    assert b"anthropic/claude-haiku-4.5" in request_body
    assert route.calls[0].request.headers["Authorization"] == "Bearer test-key"

    assert completion.text == "Hello! How can I help?"
    assert completion.input_tokens == 12
    assert completion.output_tokens == 6
    assert completion.finish_reason == "stop"
    assert completion.provider == "openrouter"
    assert completion.model == "anthropic/claude-haiku-4.5"
    assert completion.cost_usd > 0
