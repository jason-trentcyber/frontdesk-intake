from datetime import UTC, datetime, timedelta

import asyncpg
import pytest
from conftest import OrgFactory, requires_postgres

from frontdesk_worker.settings import Settings
from frontdesk_worker.spend import (
    get_global_spend_today_usd,
    get_org_tokens_today,
    global_ceiling_exceeded,
    org_budget_exceeded,
    resolve_provider,
)
from llm.fake import FakeProvider
from llm.openrouter import OpenRouterProvider


def _settings(**overrides: object) -> Settings:
    base: dict[str, object] = {
        "database_url": "unused",
        "queue_provider": "pgmq",
        "llm_provider": "openrouter",
        "llm_model": "haiku",
        "visibility_timeout_seconds": 15,
        "max_delivery_attempts": 5,
        "global_daily_spend_ceiling_usd": 1.0,
        "aws_region": None,
        "aws_endpoint_url": None,
        "sqs_queue_url": None,
        "sqs_dlq_url": None,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


@requires_postgres
async def test_get_org_tokens_today_sums_only_that_org_and_only_today(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org()
    org_b = await org_factory.make_org()

    request_a = await org_factory.make_request(org_a)
    await org_factory.make_draft(org_a, request_a, tokens_in=100, tokens_out=50)
    await org_factory.make_draft(org_a, request_a, tokens_in=10, tokens_out=5)
    # Yesterday - excluded from "today"'s sum.
    yesterday = datetime.now(UTC) - timedelta(days=1)
    await org_factory.make_draft(
        org_a, request_a, tokens_in=9000, tokens_out=9000, created_at=yesterday
    )

    request_b = await org_factory.make_request(org_b)
    await org_factory.make_draft(org_b, request_b, tokens_in=1000, tokens_out=1000)

    assert await get_org_tokens_today(app_pool, org_a) == 165
    assert await get_org_tokens_today(app_pool, org_b) == 2000


@requires_postgres
async def test_org_budget_exceeded(app_pool: asyncpg.Pool, org_factory: OrgFactory) -> None:
    org_id = await org_factory.make_org()
    request_id = await org_factory.make_request(org_id)
    await org_factory.make_draft(org_id, request_id, tokens_in=60, tokens_out=50)

    assert await org_budget_exceeded(app_pool, org_id, daily_token_budget=200) is False
    assert await org_budget_exceeded(app_pool, org_id, daily_token_budget=100) is True


@requires_postgres
async def test_global_spend_today_usd_sums_across_orgs(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org()
    org_b = await org_factory.make_org()
    request_a = await org_factory.make_request(org_a)
    request_b = await org_factory.make_request(org_b)

    # 1M input tokens + 1M output tokens at haiku pricing ($1.00 / $5.00 per
    # million) = $6.00 total, split across two orgs.
    await org_factory.make_draft(
        org_a, request_a, tokens_in=500_000, tokens_out=500_000, model="anthropic/claude-haiku-4.5"
    )
    await org_factory.make_draft(
        org_b, request_b, tokens_in=500_000, tokens_out=500_000, model="anthropic/claude-haiku-4.5"
    )
    # An unrecognized model id is excluded, not fatal.
    await org_factory.make_draft(
        org_a, request_a, tokens_in=999, tokens_out=999, model="not-a-real-model"
    )

    spend = await get_global_spend_today_usd(app_pool)

    assert spend == 6.0


@requires_postgres
async def test_global_ceiling_exceeded(app_pool: asyncpg.Pool, org_factory: OrgFactory) -> None:
    org_id = await org_factory.make_org()
    request_id = await org_factory.make_request(org_id)
    await org_factory.make_draft(
        org_id,
        request_id,
        tokens_in=100_000,
        tokens_out=100_000,
        model="anthropic/claude-haiku-4.5",
    )
    # 100k in + 100k out at $1/$5 per million = $0.60.

    assert await global_ceiling_exceeded(app_pool, ceiling_usd=1.0) is False
    assert await global_ceiling_exceeded(app_pool, ceiling_usd=0.5) is True


@requires_postgres
async def test_resolve_provider_falls_back_to_fake_when_org_budget_exceeded(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_id = await org_factory.make_org()
    request_id = await org_factory.make_request(org_id)
    await org_factory.make_draft(org_id, request_id, tokens_in=1000, tokens_out=1000)

    provider = await resolve_provider(app_pool, _settings(), org_id, daily_token_budget=500)

    assert isinstance(provider, FakeProvider)


@requires_postgres
async def test_resolve_provider_uses_the_configured_provider_when_under_budget(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENROUTER_API_KEY", "test-key")
    org_id = await org_factory.make_org()

    provider = await resolve_provider(app_pool, _settings(), org_id, daily_token_budget=200_000)

    assert isinstance(provider, OpenRouterProvider)


@requires_postgres
async def test_resolve_provider_respects_the_fake_killswitch_without_querying_spend(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    # A bogus org id would make any spend query fail if resolve_provider
    # queried it - proving layer 4 short-circuits layers 2/3 entirely.
    provider = await resolve_provider(
        app_pool,
        _settings(llm_provider="fake"),
        "00000000-0000-0000-0000-000000000000",
        daily_token_budget=1,
    )

    assert isinstance(provider, FakeProvider)
