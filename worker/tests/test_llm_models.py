import pytest

from llm import alias_for_model_id, pricing_usd_per_million_tokens, resolve_model_id


def test_haiku_resolves_per_provider() -> None:
    assert resolve_model_id("haiku", "openrouter") == "anthropic/claude-haiku-4.5"
    assert resolve_model_id("haiku", "bedrock").startswith("anthropic.claude-haiku-4-5")


def test_unknown_alias_raises() -> None:
    with pytest.raises(ValueError, match="Unknown model alias"):
        resolve_model_id("not-a-real-alias", "openrouter")


def test_alias_for_model_id_round_trips() -> None:
    model_id = resolve_model_id("haiku", "openrouter")
    assert alias_for_model_id(model_id) == "haiku"


def test_alias_for_model_id_unknown_returns_none() -> None:
    assert alias_for_model_id("not-a-real-model-id") is None


def test_pricing_is_positive() -> None:
    price_in, price_out = pricing_usd_per_million_tokens("haiku")
    assert price_in > 0
    assert price_out > 0
