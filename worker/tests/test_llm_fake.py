from llm import Message
from llm.fake import FakeProvider


async def test_fake_provider_is_deterministic_and_costs_nothing() -> None:
    provider = FakeProvider(model_alias="haiku")
    messages = [Message(role="user", content="hello there")]

    first = await provider.complete(messages, max_tokens=100, temperature=0.0)
    second = await provider.complete(messages, max_tokens=100, temperature=0.0)

    assert first == second
    assert first.cost_usd == 0.0
    assert first.provider == "fake"
    assert first.finish_reason == "stop"
