import time
import uuid
from pathlib import Path

import asyncpg
import pytest
from conftest import OrgFactory, requires_postgres

from frontdesk_worker.db import for_org
from frontdesk_worker.ingestion.embedder import Embedder, ModelNotFetched
from frontdesk_worker.ingestion.pipeline import DocumentNotFound, run_ingestion_pipeline

try:
    _embedder = Embedder()
except ModelNotFetched:
    _embedder = None

requires_model = pytest.mark.skipif(
    _embedder is None,
    reason="worker/models/bge-small-en-v1.5/ not fetched - run `uv run python scripts/fetch_model.py`",
)

_SEED_DIR = Path(__file__).resolve().parents[2] / "db" / "seed" / "bright-smile-dental"

_MINIMAL_PDF = (
    b"%PDF-1.4\n"
    b"1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"
    b"2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n"
    b"3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> "
    b"/MediaBox [0 0 612 792] /Contents 5 0 R >>\nendobj\n"
    b"4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n"
    b"5 0 obj\n<< /Length 44 >>\nstream\n"
    b"BT /F1 24 Tf 72 712 Td (PDF ingestion works) Tj ET"
    b"\nendstream\nendobj\n"
    b"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF"
)


@requires_postgres
@requires_model
async def test_ingests_a_markdown_document_end_to_end(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org()
    raw = b"# Common Procedures\n\n## Cleanings\n\nA routine cleaning is recommended every six months."
    doc_id = await org_factory.make_document(org_id, raw=raw, mime="text/markdown")

    async with for_org(app_pool, org_id) as conn:
        await run_ingestion_pipeline(conn, _embedder, org_id, doc_id)

        doc = await conn.fetchrow(
            "select status, chunk_count, error, text_content from documents where id = $1", doc_id
        )
        assert doc is not None
        assert doc["status"] == "indexed"
        assert doc["chunk_count"] >= 1
        assert doc["error"] is None
        assert "Cleanings" in doc["text_content"]

        chunks = await conn.fetch(
            "select ord, text, embedding is not null as has_embedding from chunks "
            "where document_id = $1 order by ord",
            doc_id,
        )
        assert len(chunks) == doc["chunk_count"]
        assert all(c["has_embedding"] for c in chunks)
        assert chunks[0]["ord"] == 0
        assert "## Cleanings" in chunks[0]["text"]


@requires_postgres
@requires_model
async def test_ingests_a_pdf_document_end_to_end(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org()
    doc_id = await org_factory.make_document(org_id, raw=_MINIMAL_PDF, mime="application/pdf")

    async with for_org(app_pool, org_id) as conn:
        await run_ingestion_pipeline(conn, _embedder, org_id, doc_id)

        doc = await conn.fetchrow(
            "select status, chunk_count, text_content from documents where id = $1", doc_id
        )
        assert doc is not None
        assert doc["status"] == "indexed"
        assert doc["chunk_count"] == 1
        assert "PDF ingestion works" in doc["text_content"]


@requires_postgres
@requires_model
async def test_missing_document_raises_document_not_found(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org()
    missing_document_id = str(uuid.uuid4())

    async with for_org(app_pool, org_id) as conn:
        with pytest.raises(DocumentNotFound):
            await run_ingestion_pipeline(conn, _embedder, org_id, missing_document_id)


@requires_postgres
@requires_model
async def test_unsupported_mime_type_marks_the_document_failed_without_raising(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org()
    doc_id = await org_factory.make_document(org_id, raw=b"whatever", mime="application/msword")

    async with for_org(app_pool, org_id) as conn:
        # Must not raise - an unsupported mime type is a permanent,
        # document-content failure, not something a retry fixes (see
        # pipeline.py's header comment).
        await run_ingestion_pipeline(conn, _embedder, org_id, doc_id)

        doc = await conn.fetchrow(
            "select status, chunk_count, error from documents where id = $1", doc_id
        )
        assert doc is not None
        assert doc["status"] == "failed"
        assert doc["chunk_count"] == 0
        assert doc["error"] is not None and "application/msword" in doc["error"]

        chunk_count = await conn.fetchval(
            "select count(*) from chunks where document_id = $1", doc_id
        )
        assert chunk_count == 0


@requires_postgres
@requires_model
async def test_reingesting_replaces_chunks_rather_than_duplicating_them(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org()
    raw = b"# Doc\n\nFirst version of the content, long enough to form a chunk."
    doc_id = await org_factory.make_document(org_id, raw=raw, mime="text/markdown")

    async with for_org(app_pool, org_id) as conn:
        await run_ingestion_pipeline(conn, _embedder, org_id, doc_id)
        first_count = await conn.fetchval(
            "select count(*) from chunks where document_id = $1", doc_id
        )

        await run_ingestion_pipeline(conn, _embedder, org_id, doc_id)
        second_count = await conn.fetchval(
            "select count(*) from chunks where document_id = $1", doc_id
        )

    assert first_count >= 1
    assert second_count == first_count


@requires_postgres
@requires_model
async def test_chunks_written_for_org_a_are_invisible_under_org_b(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_a = await org_factory.make_org()
    org_b = await org_factory.make_org()
    doc_id = await org_factory.make_document(org_a, raw=b"# A\n\nOrg A's private content.")

    async with for_org(app_pool, org_a) as conn:
        await run_ingestion_pipeline(conn, _embedder, org_a, doc_id)

    async with for_org(app_pool, org_b) as conn:
        rows = await conn.fetch("select id from chunks where document_id = $1", doc_id)

    assert rows == []


@requires_postgres
async def test_cross_org_chunk_insert_raises_the_rls_violation(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org()
    org_b = await org_factory.make_org()
    doc_id = await org_factory.make_document(org_b, raw=b"# B\n\nOrg B's content.")

    with pytest.raises(asyncpg.InsufficientPrivilegeError, match="row-level security policy"):
        async with for_org(app_pool, org_a) as conn:
            await conn.execute(
                "insert into chunks (org_id, document_id, ord, text) values ($1, $2, 0, 'x')",
                org_b,
                doc_id,
            )


@requires_postgres
@requires_model
async def test_three_sample_documents_per_org_ingest_in_under_30_seconds(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    """#24's acceptance criterion, using the real seed markdown content
    (db/seed/bright-smile-dental/) as the "3 sample docs" rather than
    synthetic filler - this is genuinely what db/src/seed.ts enqueues.
    """
    assert _embedder is not None
    seed_files = sorted(_SEED_DIR.glob("*.md"))
    assert len(seed_files) >= 3, "expected at least 3 seed documents to ingest"

    org_id = await org_factory.make_org()
    doc_ids = [
        await org_factory.make_document(org_id, raw=f.read_bytes(), filename=f.name, title=f.stem)
        for f in seed_files
    ]

    started = time.monotonic()
    async with for_org(app_pool, org_id) as conn:
        for doc_id in doc_ids:
            await run_ingestion_pipeline(conn, _embedder, org_id, doc_id)
        elapsed = time.monotonic() - started

        rows = await conn.fetch(
            "select status, chunk_count from documents where id = any($1::uuid[])", doc_ids
        )

    assert elapsed < 30, (
        f"ingesting {len(doc_ids)} documents took {elapsed:.1f}s, over the 30s budget"
    )
    assert len(rows) == len(doc_ids)
    for row in rows:
        assert row["status"] == "indexed"
        assert row["chunk_count"] >= 1
