"""BedrockProvider - switch-proven, not live (ADR-0006: "requires the AWS
account; deferred"). boto3 bedrock-runtime Converse API, tested with
botocore's Stubber (tests/test_llm_bedrock.py) - no network, no credentials
needed in CI.

boto3 has no async client for bedrock-runtime; calls are off-loaded to a
thread via asyncio.to_thread, same approach as queue/sqs.py.
"""

import asyncio
from typing import Any

import boto3

from . import (
    Completion,
    Message,
    normalize_finish_reason,
    pricing_usd_per_million_tokens,
    resolve_model_id,
)


class BedrockProvider:
    def __init__(self, *, model_alias: str, region: str | None = None, client: Any = None) -> None:
        self._model_alias = model_alias
        self._model_id = resolve_model_id(model_alias, "bedrock")
        # `client` is injectable so tests can hand in a Stubber-wrapped
        # client without patching boto3 globally.
        self._client = client or boto3.client("bedrock-runtime", region_name=region)

    async def complete(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int,
        temperature: float,
    ) -> Completion:
        system = [{"text": m.content} for m in messages if m.role == "system"]
        turns = [
            {"role": m.role, "content": [{"text": m.content}]}
            for m in messages
            if m.role != "system"
        ]

        kwargs: dict[str, Any] = {
            "modelId": self._model_id,
            "messages": turns,
            "inferenceConfig": {"maxTokens": max_tokens, "temperature": temperature},
        }
        if system:
            kwargs["system"] = system
        if tools:
            kwargs["toolConfig"] = {"tools": tools}

        response = await asyncio.to_thread(self._client.converse, **kwargs)

        output_message = response["output"]["message"]
        text = "".join(block.get("text", "") for block in output_message["content"])
        usage = response.get("usage", {})
        input_tokens = int(usage.get("inputTokens", 0))
        output_tokens = int(usage.get("outputTokens", 0))
        price_in, price_out = pricing_usd_per_million_tokens(self._model_alias)
        cost_usd = (input_tokens * price_in + output_tokens * price_out) / 1_000_000

        return Completion(
            text=text,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            finish_reason=normalize_finish_reason(
                "bedrock", response.get("stopReason", "end_turn")
            ),
            cost_usd=cost_usd,
            provider="bedrock",
            model=self._model_id,
        )
