import asyncpg
import pytest
from conftest import OrgFactory, requires_postgres

from frontdesk_worker.db import for_org
from frontdesk_worker.ingestion.embedder import Embedder, ModelNotFetched
from frontdesk_worker.triage.retrieve import retrieve_chunks, similarity_floor

try:
    _embedder = Embedder()
except ModelNotFetched:
    _embedder = None

requires_model = pytest.mark.skipif(
    _embedder is None,
    reason="worker/models/bge-small-en-v1.5/ not fetched - run `uv run python scripts/fetch_model.py`",
)


def _embed(text: str) -> list[float]:
    assert _embedder is not None
    return list(_embedder.embed_batch([text])[0])


def test_similarity_floor_defaults_when_unset() -> None:
    assert similarity_floor({}) == 0.35


def test_similarity_floor_reads_the_org_override() -> None:
    assert similarity_floor({"similarityFloor": 0.5}) == 0.5


def test_similarity_floor_ignores_a_non_numeric_override() -> None:
    assert similarity_floor({"similarityFloor": "not a number"}) == 0.35


@requires_postgres
@requires_model
async def test_returns_the_most_similar_chunk_first(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_id = await org_factory.make_org()
    doc_id = await org_factory.make_document(org_id)
    dental_id = await org_factory.make_chunk(
        org_id,
        doc_id,
        ord=0,
        text="Cleanings are recommended every six months.",
        embedding=_embed("Cleanings are recommended every six months."),
    )
    unrelated_id = await org_factory.make_chunk(
        org_id,
        doc_id,
        ord=1,
        text="Our office is closed on federal holidays.",
        embedding=_embed("Our office is closed on federal holidays."),
    )

    async with for_org(app_pool, org_id) as conn:
        results = await retrieve_chunks(
            conn,
            org_id,
            _embed("How often should I get a cleaning?"),
            "How often should I get a cleaning?",
        )

    assert results
    assert results[0].id == dental_id
    result_ids = {r.id for r in results}
    # Not asserting unrelated_id's absence unconditionally - it may or may
    # not clear the floor depending on the model's exact embedding space,
    # but it must never rank ahead of the on-topic chunk.
    if unrelated_id in result_ids:
        ranks = [r.id for r in results]
        assert ranks.index(dental_id) < ranks.index(unrelated_id)


@requires_postgres
@requires_model
async def test_excludes_chunks_below_the_similarity_floor(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_id = await org_factory.make_org()
    doc_id = await org_factory.make_document(org_id)
    await org_factory.make_chunk(
        org_id,
        doc_id,
        ord=0,
        text="Completely unrelated content about tax law in a different country.",
        embedding=_embed("Completely unrelated content about tax law in a different country."),
    )

    async with for_org(app_pool, org_id) as conn:
        results = await retrieve_chunks(
            conn,
            org_id,
            _embed("dental cleaning appointment"),
            "dental cleaning appointment",
            floor=0.99,
        )

    assert results == []


@requires_postgres
@requires_model
async def test_full_text_only_match_is_still_found_via_rrf(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    """A chunk containing the exact keyword the query uses can surface via
    full-text even if it is not the top cosine match - that's the point of
    fusing both rankings rather than using cosine alone (F6).
    """
    org_id = await org_factory.make_org()
    doc_id = await org_factory.make_document(org_id)
    keyword_id = await org_factory.make_chunk(
        org_id,
        doc_id,
        ord=0,
        text="Our Delta Dental PPO acceptance policy is documented here.",
        embedding=_embed("Our Delta Dental PPO acceptance policy is documented here."),
    )

    async with for_org(app_pool, org_id) as conn:
        results = await retrieve_chunks(
            conn, org_id, _embed("random unrelated query vector"), "Delta Dental PPO", floor=0.0
        )

    assert keyword_id in {r.id for r in results}


@requires_postgres
@requires_model
async def test_chunks_from_org_a_are_invisible_when_retrieving_under_org_b(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org()
    org_b = await org_factory.make_org()
    doc_a = await org_factory.make_document(org_a)
    query = "dental cleaning appointment"
    await org_factory.make_chunk(
        org_a,
        doc_a,
        ord=0,
        text="Cleanings are recommended every six months.",
        embedding=_embed(query),
    )

    async with for_org(app_pool, org_b) as conn:
        results = await retrieve_chunks(conn, org_b, _embed(query), query, floor=0.0)

    assert results == []


@requires_postgres
async def test_no_chunks_at_all_returns_an_empty_list(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_id = await org_factory.make_org()

    async with for_org(app_pool, org_id) as conn:
        results = await retrieve_chunks(conn, org_id, [0.0] * 384, "anything")

    assert results == []
