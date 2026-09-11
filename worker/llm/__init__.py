"""LLMProvider interface (ADR-0006). This is the ONLY directory in the repo
allowed to name a provider - tests/test_provider_isolation.py grep-enforces
it. Selection by LLM_PROVIDER env only.
"""

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

import yaml

_MODELS_PATH = Path(__file__).resolve().parent / "models.yaml"

# The only place these names live outside this package's own source text
# (ADR-0006's grep test, tests/test_provider_isolation.py) - settings.py
# imports this set instead of spelling the names itself, so it can validate
# LLM_PROVIDER without becoming a second place a provider is named.
KNOWN_PROVIDERS = frozenset({"openrouter", "bedrock", "fake"})


@dataclass(frozen=True)
class Message:
    role: str  # "system" | "user" | "assistant"
    content: str


@dataclass(frozen=True)
class Completion:
    text: str
    input_tokens: int
    output_tokens: int
    finish_reason: str
    cost_usd: float
    provider: str
    model: str


# Each provider's raw stop-reason vocabulary, normalized to a common one so
# provider-parity (tests/test_provider_parity.py) can compare Completions
# across adapters field-for-field instead of hard-coding each provider's own
# strings into the shared test.
_FINISH_REASON_NORMALIZATION: dict[str, dict[str, str]] = {
    "openrouter": {"stop": "stop", "length": "length", "tool_calls": "tool_calls"},
    "bedrock": {"end_turn": "stop", "max_tokens": "length", "tool_use": "tool_calls"},
}


def normalize_finish_reason(provider: str, raw: str) -> str:
    return _FINISH_REASON_NORMALIZATION.get(provider, {}).get(raw, raw)


class LLMProvider(Protocol):
    async def complete(
        self,
        messages: list[Message],
        *,
        tools: list[dict[str, Any]] | None = None,
        max_tokens: int,
        temperature: float,
    ) -> Completion: ...


@lru_cache(maxsize=1)
def _models() -> dict[str, Any]:
    return yaml.safe_load(_MODELS_PATH.read_text())


def resolve_model_id(alias: str, provider: str) -> str:
    """LLM_MODEL=<alias> -> the provider-specific model id, per models.yaml."""
    models = _models()
    entry = models.get(alias)
    if entry is None:
        raise ValueError(f"Unknown model alias {alias!r} - not in llm/models.yaml")
    model_id = entry.get(provider)
    if not model_id:
        raise ValueError(f"Model alias {alias!r} has no {provider!r} entry in llm/models.yaml")
    return model_id


def alias_for_model_id(model_id: str) -> str | None:
    """Reverse of resolve_model_id: a provider-specific model id (as stored
    in drafts.model by whichever code writes drafts) back to its
    models.yaml alias, for the spend estimate in frontdesk_worker/spend.py.
    Returns None for an id not in models.yaml (an older or manually-set
    model) rather than raising - the global ceiling should degrade to
    undercounting that row, not crash the budget check.
    """
    for alias, entry in _models().items():
        if model_id in (entry.get("openrouter"), entry.get("bedrock")):
            return alias
    return None


def pricing_usd_per_million_tokens(alias: str) -> tuple[float, float]:
    """Returns (input, output) price per million tokens for an alias, used by
    the worker's own spend estimate (ADR-0023 §5) - not authoritative
    billing, see models.yaml's header comment.
    """
    entry = _models().get(alias)
    if entry is None:
        raise ValueError(f"Unknown model alias {alias!r} - not in llm/models.yaml")
    pricing = entry.get("pricing_usd_per_million_tokens")
    if not pricing:
        raise ValueError(f"Model alias {alias!r} has no pricing in llm/models.yaml")
    return float(pricing["input"]), float(pricing["output"])


def get_provider(name: str, *, model_alias: str) -> LLMProvider:
    """Selection by LLM_PROVIDER env only (ADR-0006) - no auto-detection.

    Reads any provider-specific secret (OPENROUTER_API_KEY) from the
    environment itself rather than taking it as a parameter, so no caller
    outside this package ever needs to know that variable's name either -
    keeping it, like the provider names themselves, inside worker/llm/.
    """
    if name == "fake":
        from .fake import FakeProvider

        return FakeProvider(model_alias=model_alias)
    if name == "openrouter":
        from .openrouter import OpenRouterProvider

        api_key = os.environ.get("OPENROUTER_API_KEY")
        if not api_key:
            raise ValueError("OPENROUTER_API_KEY is required when LLM_PROVIDER=openrouter")
        return OpenRouterProvider(api_key=api_key, model_alias=model_alias)
    if name == "bedrock":
        from .bedrock import BedrockProvider

        return BedrockProvider(model_alias=model_alias)
    raise ValueError(f"Unknown LLM_PROVIDER: {name}")
