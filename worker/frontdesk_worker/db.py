"""Postgres access (ADR-0023 §1): asyncpg, hand-written SQL, no ORM.

Mirrors db/src/client.ts's forOrg() - same pattern, same reason: a pooled
connection must never leak one request's org context into the next. The
worker connects as frontdesk_app (NOBYPASSRLS, deploy/postgres/README.md);
it performs no DDL and no migrations.

Callers still put org_id in their own WHERE/INSERT clauses (AGENTS.md:
"Every query on a tenant table includes org_id. No exceptions") - RLS is
the backstop, not the only line (docs/conventions.md → Data and tenancy).
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import asyncpg


async def create_pool(dsn: str) -> asyncpg.Pool:
    pool = await asyncpg.create_pool(dsn=dsn)
    if pool is None:  # pragma: no cover - asyncpg only returns None if min_size=0 and never used
        raise RuntimeError("asyncpg.create_pool returned None")
    return pool


@asynccontextmanager
async def for_org(
    pool: asyncpg.Pool, org_id: str
) -> AsyncIterator[asyncpg.pool.PoolConnectionProxy]:
    """Acquires a connection, opens a transaction, and sets app.org_id for it.

    The `true` third argument to set_config is load-bearing: it makes the GUC
    transaction-local, so returning the connection to the pool clears it - the
    same guarantee db/src/client.ts's forOrg() gives via a Drizzle transaction.
    """
    async with pool.acquire() as conn, conn.transaction():
        await conn.execute("select set_config('app.org_id', $1, true)", org_id)
        yield conn
