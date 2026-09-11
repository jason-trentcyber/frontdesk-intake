"""Spend controls (ADR-0023 §5) - four independent layers, all required:

1. Vendor cap on the live provider's own key. Nothing to build.
2. Per-org daily token budget, enforced here.
3. Global daily spend ceiling: on breach, force FakeProvider for the rest of
   the UTC day and log loudly - never start erroring. A visibly-fake draft
   is diagnosable; a missing draft looks identical to a broken worker.
4. LLM_PROVIDER=fake killswitch - falls out of llm.get_provider()'s env
   selection with no code here.

Storage decision: no new table, no migration. orgs.daily_token_budget
already exists (db/src/schema/orgs.ts) - it is the per-org threshold, not
something #23 needs to invent. Spend-to-date for both layer 2 and layer 3 is
derived by summing drafts.tokens_in/tokens_out, which are already per-org
and already what the UI shows (F12's audit trail) - the brief's preferred
option over a new table. The global figure has no per-row cost_usd to sum
(drafts doesn't carry one), so it's estimated from tokens via
llm/models.yaml's pricing table instead; see that file's header for why
that estimate isn't billing-accurate.

The global ceiling necessarily loops over every org's drafts individually,
one for_org() at a time: frontdesk_app is NOBYPASSRLS (ADR-0007), so there
is no single unscoped query that sums every org's spend in one shot. orgs
itself is the one unscoped read allowed here (it's in NON_TENANT_TABLES,
db/src/client.ts) - only its id column is used, to loop.
"""

import logging

import asyncpg

from llm import LLMProvider, alias_for_model_id, get_provider, pricing_usd_per_million_tokens

from .db import for_org
from .settings import Settings

logger = logging.getLogger(__name__)

_TODAY_UTC_SQL = "created_at >= date_trunc('day', now() at time zone 'utc')"


async def get_org_tokens_today(pool: asyncpg.Pool, org_id: str) -> int:
    async with for_org(pool, org_id) as conn:
        total = await conn.fetchval(
            f"select coalesce(sum(tokens_in + tokens_out), 0) from drafts "
            f"where org_id = $1 and {_TODAY_UTC_SQL}",
            org_id,
        )
    # coalesce(..., 0) guarantees a non-null result; the `or 0` is only to
    # satisfy the type checker, which can't see that from fetchval()'s
    # general signature.
    return int(total or 0)


async def org_budget_exceeded(pool: asyncpg.Pool, org_id: str, daily_token_budget: int) -> bool:
    """Layer 2. Callers pass the org's own orgs.daily_token_budget (the
    worker performs no DDL/migrations and does not own that table)."""
    used = await get_org_tokens_today(pool, org_id)
    exceeded = used >= daily_token_budget
    if exceeded:
        logger.warning(
            "org daily token budget exceeded",
            extra={"org_id": org_id, "tokens_used": used, "daily_token_budget": daily_token_budget},
        )
    return exceeded


async def get_global_spend_today_usd(pool: asyncpg.Pool) -> float:
    async with pool.acquire() as conn:
        org_ids = [str(row["id"]) for row in await conn.fetch("select id from orgs")]

    total_usd = 0.0
    for org_id in org_ids:
        async with for_org(pool, org_id) as conn:
            rows = await conn.fetch(
                f"select model, sum(tokens_in) as tin, sum(tokens_out) as tout "
                f"from drafts where org_id = $1 and {_TODAY_UTC_SQL} group by model",
                org_id,
            )
        for row in rows:
            alias = alias_for_model_id(row["model"])
            if alias is None:
                logger.warning(
                    "drafts row has a model id not in llm/models.yaml - excluded from the "
                    "global spend estimate",
                    extra={"org_id": org_id, "model": row["model"]},
                )
                continue
            price_in, price_out = pricing_usd_per_million_tokens(alias)
            total_usd += (int(row["tin"]) * price_in + int(row["tout"]) * price_out) / 1_000_000
    return total_usd


async def global_ceiling_exceeded(pool: asyncpg.Pool, ceiling_usd: float) -> bool:
    """Layer 3."""
    spend = await get_global_spend_today_usd(pool)
    exceeded = spend >= ceiling_usd
    if exceeded:
        logger.warning(
            "global daily spend ceiling exceeded - switching to FakeProvider for the rest of "
            "the UTC day",
            extra={"spend_usd": spend, "ceiling_usd": ceiling_usd},
        )
    return exceeded


async def resolve_provider(
    pool: asyncpg.Pool, settings: Settings, org_id: str, daily_token_budget: int
) -> LLMProvider:
    """The seam #25's pipeline calls instead of llm.get_provider() directly -
    combines all four spend-control layers with the env selection into one
    provider choice. Layer 4 (LLM_PROVIDER=fake) falls out of get_provider()
    itself; layers 2 and 3 downgrade to FakeProvider here, loudly, rather
    than erroring - a fake draft is diagnosable, a missing one looks like a
    crash.
    """
    if settings.llm_provider != "fake" and (
        await org_budget_exceeded(pool, org_id, daily_token_budget)
        or await global_ceiling_exceeded(pool, settings.global_daily_spend_ceiling_usd)
    ):
        return get_provider("fake", model_alias=settings.llm_model)
    return get_provider(settings.llm_provider, model_alias=settings.llm_model)
