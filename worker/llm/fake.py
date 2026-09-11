"""Deterministic, no-network provider - unit tests, the eval harness's cached
mode, and the LLM_PROVIDER=fake killswitch (ADR-0023 §5 layer 4), plus the
target the global spend ceiling (layer 3) switches to on breach.
"""

from . import Completion, Message


class FakeProvider:
    def __init__(self, *, model_alias: str = "haiku") -> None:
        self._model_alias = model_alias

    async def complete(
        self,
        messages: list[Message],
        *,
        tools: list[dict] | None = None,
        max_tokens: int,
        temperature: float,
    ) -> Completion:
        # Deterministic on the last user message so tests can assert on
        # content without recording fixtures; no network, ever.
        last_user = next((m.content for m in reversed(messages) if m.role == "user"), "")
        input_tokens = sum(len(m.content.split()) for m in messages)
        text = f"[fake completion for: {last_user[:80]}]"
        return Completion(
            text=text,
            input_tokens=input_tokens,
            output_tokens=len(text.split()),
            finish_reason="stop",
            cost_usd=0.0,
            provider="fake",
            model=self._model_alias,
        )
