"""OpenRouterProvider - live in dev, CI (fixture-recorded only), and prod.

httpx, chat-completions-compatible endpoint. Test fixtures are recorded with
respx (tests/test_llm_openrouter.py) - no network and no API key in CI
(ADR-0006's switch-proof).
"""

from typing import Any

import httpx

from . import (
    Completion,
    Message,
    normalize_finish_reason,
    pricing_usd_per_million_tokens,
    resolve_model_id,
)

_BASE_URL = "https://openrouter.ai/api/v1/chat/completions"


class OpenRouterProvider:
    def __init__(self, *, api_key: str, model_alias: str, timeout: float = 30.0) -> None:
        self._api_key = api_key
        self._model_alias = model_alias
        self._model_id = resolve_model_id(model_alias, "openrouter")
        self._timeout = timeout

    async def complete(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int,
        temperature: float,
    ) -> Completion:
        body: dict[str, Any] = {
            "model": self._model_id,
            "messages": [{"role": m.role, "content": m.content} for m in messages],
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if tools:
            body["tools"] = tools

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.post(
                _BASE_URL,
                headers={"Authorization": f"Bearer {self._api_key}"},
                json=body,
            )
        response.raise_for_status()
        data = response.json()

        choice = data["choices"][0]
        usage = data.get("usage", {})
        input_tokens = int(usage.get("prompt_tokens", 0))
        output_tokens = int(usage.get("completion_tokens", 0))
        price_in, price_out = pricing_usd_per_million_tokens(self._model_alias)
        cost_usd = (input_tokens * price_in + output_tokens * price_out) / 1_000_000

        return Completion(
            text=choice["message"]["content"],
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            finish_reason=normalize_finish_reason(
                "openrouter", choice.get("finish_reason", "stop")
            ),
            cost_usd=cost_usd,
            provider="openrouter",
            model=self._model_id,
        )
