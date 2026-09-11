import asyncpg
import pytest
from conftest import OrgFactory, requires_postgres

from frontdesk_worker.db import for_org


@requires_postgres
async def test_for_org_hides_other_orgs_rows(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org()
    org_b = await org_factory.make_org()
    request_b = await org_factory.make_request(org_b)

    async with for_org(app_pool, org_a) as conn:
        rows = await conn.fetch("select id from requests where id = $1", request_b)

    assert rows == []


@requires_postgres
async def test_for_org_blocks_cross_org_insert(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org()
    org_b = await org_factory.make_org()

    with pytest.raises(asyncpg.InsufficientPrivilegeError, match="row-level security policy"):
        async with for_org(app_pool, org_a) as conn:
            await conn.execute(
                """
                insert into requests (org_id, source, subject, body, tracking_token)
                values ($1, 'api', 'x', 'x', $2)
                """,
                org_b,
                f"cross-org-{org_b}",
            )


@requires_postgres
async def test_for_org_guc_does_not_survive_the_transaction(
    single_conn_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org()

    # single_conn_pool has exactly one physical connection, so this
    # acquire()/for_org()/release() and the one below are guaranteed to be
    # the same connection - a leaked GUC would otherwise be masked by a
    # fresh one from a larger pool.
    async with for_org(single_conn_pool, org_a):
        pass  # connection released back to the pool here

    async with single_conn_pool.acquire() as conn:
        value = await conn.fetchval("select current_setting('app.org_id', true)")

    assert value in (None, "")
