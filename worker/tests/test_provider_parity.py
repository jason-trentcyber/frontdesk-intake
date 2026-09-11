"""The provider-parity CI job (ADR-0006 switch-proof): identical normalized
Completion across all three adapters for identical inputs. Recorded
fixtures only - no network, no API key.
"""

import boto3
import httpx
import respx
from botocore.stub import Stubber

from llm import Message
from llm.bedrock import BedrockProvider
from llm.fake import FakeProvider
from llm.openrouter import OpenRouterProvider

_MESSAGES = [Message(role="user", content="What are your hours?")]
_TEXT = "We are open 9 to 5."
_INPUT_TOKENS = 10
_OUTPUT_TOKENS = 8


async def _openrouter_completion():
    with respx.mock:
        respx.post("https://openrouter.ai/api/v1/chat/completions").mock(
            return_value=httpx.Response(
                200,
                json={
                    "choices": [{"message": {"content": _TEXT}, "finish_reason": "stop"}],
                    "usage": {
                        "prompt_tokens": _INPUT_TOKENS,
                        "completion_tokens": _OUTPUT_TOKENS,
                    },
                },
            )
        )
        provider = OpenRouterProvider(api_key="test-key", model_alias="haiku")
        return await provider.complete(_MESSAGES, max_tokens=100, temperature=0.0)


async def _bedrock_completion():
    client = boto3.client("bedrock-runtime", region_name="us-east-1")
    stubber = Stubber(client)
    stubber.add_response(
        "converse",
        {
            "output": {"message": {"role": "assistant", "content": [{"text": _TEXT}]}},
            "stopReason": "end_turn",
            "usage": {
                "inputTokens": _INPUT_TOKENS,
                "outputTokens": _OUTPUT_TOKENS,
                "totalTokens": _INPUT_TOKENS + _OUTPUT_TOKENS,
            },
            "metrics": {"latencyMs": 123},
        },
        {
            "modelId": "anthropic.claude-haiku-4-5-20251001-v1:0",
            "messages": [{"role": "user", "content": [{"text": "What are your hours?"}]}],
            "inferenceConfig": {"maxTokens": 100, "temperature": 0.0},
        },
    )
    stubber.activate()
    provider = BedrockProvider(model_alias="haiku", client=client)
    return await provider.complete(_MESSAGES, max_tokens=100, temperature=0.0)


async def _fake_completion():
    # FakeProvider is deliberately not fixture-driven (it has no network to
    # record against), so only the fields that are meaningful for every
    # provider - not FakeProvider's own templated text - are compared below.
    provider = FakeProvider(model_alias="haiku")
    return await provider.complete(_MESSAGES, max_tokens=100, temperature=0.0)


async def test_normalized_completion_shape_is_identical_across_adapters() -> None:
    openrouter = await _openrouter_completion()
    bedrock = await _bedrock_completion()
    fake = await _fake_completion()

    for completion in (openrouter, bedrock, fake):
        assert completion.finish_reason == "stop"
        assert isinstance(completion.text, str) and completion.text
        assert isinstance(completion.input_tokens, int)
        assert isinstance(completion.output_tokens, int)
        assert isinstance(completion.cost_usd, float)
        assert completion.provider in ("openrouter", "bedrock", "fake")

    # The two recorded-fixture adapters get the exact same tokens/text back
    # for the exact same input - only their provider/model labels and cost
    # differ (different providers, same alias -> same pricing table, so
    # cost_usd matches too for equal token counts).
    assert openrouter.text == bedrock.text == _TEXT
    assert openrouter.input_tokens == bedrock.input_tokens == _INPUT_TOKENS
    assert openrouter.output_tokens == bedrock.output_tokens == _OUTPUT_TOKENS
    assert openrouter.cost_usd == bedrock.cost_usd
    assert openrouter.provider != bedrock.provider
