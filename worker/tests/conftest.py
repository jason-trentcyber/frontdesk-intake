"""Shared Postgres fixtures. Needs a real Postgres (docs/adr/0023-worker-runtime-shape.md
§1's for_org() tests are "the point of" db.py) - CI's python job runs the same
service container as the db/ and api/ jobs; locally, `make up` provides it.

Fixtures skip (not fail) when the required env vars are absent, mirroring how
api/'s vitest suite gates itself on DATABASE_APP_URL - CI must never let that
happen silently, which is exactly what the python job's "assert nothing
skipped" step (mirroring api/'s) checks for.

Row setup uses the *owner* role (DATABASE_URL, frontdesk) directly, without
set_config, for the same reason db/src/seed.ts's upsertDemoRequests() does:
RLS's default ENABLE (not FORCE) ROW LEVEL SECURITY does not apply to a
table's owning role. Tests that exercise for_org()/spend.py itself always go
through the frontdesk_app pool - that's the boundary under test.
"""

import hashlib
import json
import os
import uuid
from collections.abc import AsyncGenerator
from datetime import datetime

import asyncpg
import pytest

OWNER_DSN = os.environ.get("DATABASE_URL")
APP_DSN = os.environ.get("DATABASE_APP_URL")

requires_postgres = pytest.mark.skipif(
    not OWNER_DSN or not APP_DSN,
    reason="DATABASE_URL and DATABASE_APP_URL are required for Postgres-backed tests",
)


@pytest.fixture
async def owner_conn() -> AsyncGenerator[asyncpg.Connection]:
    assert OWNER_DSN
    conn = await asyncpg.connect(dsn=OWNER_DSN)
    try:
        yield conn
    finally:
        await conn.close()


@pytest.fixture
async def app_pool() -> AsyncGenerator[asyncpg.Pool]:
    assert APP_DSN
    pool = await asyncpg.create_pool(dsn=APP_DSN, min_size=1, max_size=4)
    assert pool is not None
    try:
        yield pool
    finally:
        await pool.close()


@pytest.fixture
async def single_conn_pool() -> AsyncGenerator[asyncpg.Pool]:
    """A pool pinned to exactly one physical connection - needed to prove the
    GUC doesn't survive a transaction on the *same* connection (a pool with
    room for more than one would let a fresh connection mask a real leak).
    """
    assert APP_DSN
    pool = await asyncpg.create_pool(dsn=APP_DSN, min_size=1, max_size=1)
    assert pool is not None
    try:
        yield pool
    finally:
        await pool.close()


class OrgFactory:
    """Creates orgs/requests/drafts as the owner role and tracks them for
    teardown. Every row is tagged with a random slug/tracking-token per
    test so tests never collide or depend on seed data.
    """

    def __init__(self, conn: asyncpg.Connection) -> None:
        self._conn = conn
        self._org_ids: list[str] = []

    async def make_org(
        self, *, daily_token_budget: int = 200_000, settings: dict[str, object] | None = None
    ) -> str:
        slug = f"test-org-{uuid.uuid4().hex[:12]}"
        row = await self._conn.fetchrow(
            "insert into orgs (slug, name, daily_token_budget, settings) "
            "values ($1, $2, $3, $4::jsonb) returning id",
            slug,
            slug,
            daily_token_budget,
            json.dumps(settings or {}),
        )
        assert row is not None
        org_id = str(row["id"])
        self._org_ids.append(org_id)
        return org_id

    async def make_request(
        self, org_id: str, *, subject: str = "test", body: str = "test body"
    ) -> str:
        # `body` defaults to a single throwaway word rather than a realistic
        # sentence on purpose: a test that cares about full-text matching
        # (retrieval, the triage pipeline) must pass a real body explicitly -
        # a generic realistic-looking default here would have hidden the
        # exact bug it should be forcing every caller to think about
        # (plainto_tsquery AND-joining a whole email into an unsatisfiable
        # query, #105's review finding).
        token = f"test-{uuid.uuid4().hex}"
        row = await self._conn.fetchrow(
            """
            insert into requests (org_id, source, subject, body, tracking_token)
            values ($1, 'api', $2, $3, $4)
            returning id
            """,
            org_id,
            subject,
            body,
            token,
        )
        assert row is not None
        return str(row["id"])

    async def make_draft(
        self,
        org_id: str,
        request_id: str,
        *,
        tokens_in: int,
        tokens_out: int,
        model: str = "anthropic/claude-haiku-4.5",
        created_at: datetime | None = None,
    ) -> None:
        # `version` is allocated as max+1 per (org_id, request_id) rather
        # than hardcoded, because drafts_org_id_request_id_version_unique
        # (migration 0008) makes a second draft for the same request a
        # constraint violation otherwise. Same allocation production uses
        # (web/src/lib/staffActions.ts), so a test that drafts twice
        # exercises the real shape instead of a state the DB rejects.
        if created_at is None:
            await self._conn.execute(
                """
                insert into drafts (org_id, request_id, version, body, confidence, model,
                                     prompt_version, tokens_in, tokens_out)
                select $1, $2, coalesce(max(d.version), 0) + 1, 'test draft', 0, $3, 'test', $4, $5
                from drafts d where d.org_id = $1 and d.request_id = $2
                """,
                org_id,
                request_id,
                model,
                tokens_in,
                tokens_out,
            )
        else:
            await self._conn.execute(
                """
                insert into drafts (org_id, request_id, version, body, confidence, model,
                                     prompt_version, tokens_in, tokens_out, created_at)
                select $1, $2, coalesce(max(d.version), 0) + 1, 'test draft', 0, $3, 'test', $4,
                       $5, $6
                from drafts d where d.org_id = $1 and d.request_id = $2
                """,
                org_id,
                request_id,
                model,
                tokens_in,
                tokens_out,
                created_at,
            )

    async def make_document(
        self,
        org_id: str,
        *,
        title: str = "test doc",
        filename: str = "test.md",
        mime: str = "text/markdown",
        raw: bytes = b"# Test\n\nHello world.",
        status: str = "pending",
    ) -> str:
        # sha256 is part of documents_org_id_sha256_unique - vary `raw` per
        # call within a test if more than one document is needed.
        sha256 = hashlib.sha256(raw).hexdigest()
        row = await self._conn.fetchrow(
            """
            insert into documents (org_id, title, filename, mime, sha256, raw, status)
            values ($1, $2, $3, $4, $5, $6, $7)
            returning id
            """,
            org_id,
            title,
            filename,
            mime,
            sha256,
            raw,
            status,
        )
        assert row is not None
        return str(row["id"])

    async def make_chunk(
        self,
        org_id: str,
        document_id: str,
        *,
        ord: int,
        text: str,
        embedding: list[float] | None = None,
    ) -> str:
        embedding_literal = None
        if embedding is not None:
            embedding_literal = "[" + ",".join(str(float(x)) for x in embedding) + "]"
        row = await self._conn.fetchrow(
            """
            insert into chunks (org_id, document_id, ord, text, embedding)
            values ($1, $2, $3, $4, $5::vector)
            returning id
            """,
            org_id,
            document_id,
            ord,
            text,
            embedding_literal,
        )
        assert row is not None
        return str(row["id"])

    async def cleanup(self) -> None:
        for org_id in self._org_ids:
            await self._conn.execute("delete from drafts where org_id = $1", org_id)
            await self._conn.execute("delete from requests where org_id = $1", org_id)
            # chunks cascade off documents (ON DELETE CASCADE) - no separate
            # delete needed.
            await self._conn.execute("delete from documents where org_id = $1", org_id)
            await self._conn.execute("delete from orgs where id = $1", org_id)


@pytest.fixture
async def org_factory(owner_conn: asyncpg.Connection) -> AsyncGenerator[OrgFactory]:
    factory = OrgFactory(owner_conn)
    try:
        yield factory
    finally:
        await factory.cleanup()
