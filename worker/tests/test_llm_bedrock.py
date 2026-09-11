"""botocore Stubber test - no network, no AWS credentials (ADR-0006's
switch-proof). BedrockProvider takes an injectable client precisely so tests
never need to patch boto3 globally.
"""

import boto3
from botocore.stub import Stubber

from llm import Message
from llm.bedrock import BedrockProvider


async def test_complete_parses_the_stubbed_converse_response() -> None:
    client = boto3.client("bedrock-runtime", region_name="us-east-1")
    stubber = Stubber(client)

    model_id = "anthropic.claude-haiku-4-5-20251001-v1:0"
    expected_params = {
        "modelId": model_id,
        "messages": [{"role": "user", "content": [{"text": "hi"}]}],
        "inferenceConfig": {"maxTokens": 100, "temperature": 0.0},
        "system": [{"text": "be nice"}],
    }
    stubbed_response = {
        "output": {
            "message": {
                "role": "assistant",
                "content": [{"text": "Hello! How can I help?"}],
            }
        },
        "stopReason": "end_turn",
        "usage": {"inputTokens": 12, "outputTokens": 6, "totalTokens": 18},
        "metrics": {"latencyMs": 123},
    }
    stubber.add_response("converse", stubbed_response, expected_params)
    stubber.activate()

    provider = BedrockProvider(model_alias="haiku", client=client)
    completion = await provider.complete(
        [Message(role="system", content="be nice"), Message(role="user", content="hi")],
        max_tokens=100,
        temperature=0.0,
    )

    stubber.assert_no_pending_responses()
    assert completion.text == "Hello! How can I help?"
    assert completion.input_tokens == 12
    assert completion.output_tokens == 6
    assert completion.finish_reason == "stop"
    assert completion.provider == "bedrock"
    assert completion.model == model_id
    assert completion.cost_usd > 0
