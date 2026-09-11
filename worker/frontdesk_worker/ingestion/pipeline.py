"""The ingestion pipeline (ADR-0025 §2, §4): read a document, extract text,
chunk, embed in batches of at most `MAX_BATCH_SIZE`, and write `chunks` +
`documents.status`/`chunk_count`/`error`/`text_content` - all inside the
caller's `for_org()` transaction, so re-ingestion (delete existing `chunks`,
insert new ones) is atomic: a partial failure leaves no half-indexed
document.

Two failure classes, handled differently, same distinction #23's consumer
already draws between "message shape is wrong" (dead-letter, never retry)
and "processing failed" (nack, retry up to the ceiling):

- **Permanent**: an unsupported mime type, or a document whose extracted
  text produces zero chunks (an image-only PDF with no text layer, an
  empty file). Retrying changes nothing about the document's own content,
  so this pipeline catches it, writes `status = 'failed'` with
  `documents.error`, and returns normally - consumer.py then acks the
  message. A failed document is honest, visible state, not a stuck queue.
- **Transient**: anything else (a DB error, an unexpected exception) is
  left to propagate. consumer.py's existing nack/retry/dead-letter ladder
  handles it exactly as it already does for triage messages.
"""

import asyncio

import asyncpg
import numpy as np

from .chunker import chunk_markdown
from .embedder import MAX_BATCH_SIZE, Embedder
from .pdf_extract import extract_pdf_text

_TEXT_MIME_TYPES = frozenset({"text/markdown", "text/plain"})


class UnsupportedMimeType(Exception):
    pass


class DocumentNotFound(Exception):
    pass


def _extract_text(mime: str, raw: bytes) -> str:
    if mime in _TEXT_MIME_TYPES:
        return raw.decode("utf-8")
    if mime == "application/pdf":
        return extract_pdf_text(raw)
    raise UnsupportedMimeType(f"unsupported mime type: {mime!r}")


def _vector_literal(vector: np.ndarray) -> str:
    # pgvector's text input format - asyncpg has no built-in codec for a
    # third-party extension type, so this is passed as a plain string and
    # cast server-side (`$n::vector`), same approach as chunks.tsv's own
    # generated-column cast needs no driver-side mapping at all.
    return "[" + ",".join(str(float(x)) for x in vector) + "]"


async def _mark_failed(
    conn: asyncpg.pool.PoolConnectionProxy, org_id: str, document_id: str, error: str
) -> None:
    await conn.execute(
        "update documents set status = 'failed', error = $3, chunk_count = 0 "
        "where org_id = $1 and id = $2",
        org_id,
        document_id,
        error,
    )


async def run_ingestion_pipeline(
    conn: asyncpg.pool.PoolConnectionProxy,
    embedder: Embedder,
    org_id: str,
    document_id: str,
) -> None:
    doc = await conn.fetchrow(
        "select mime, raw from documents where org_id = $1 and id = $2", org_id, document_id
    )
    if doc is None:
        raise DocumentNotFound(f"document {document_id} not found for its org")

    try:
        text = _extract_text(doc["mime"], bytes(doc["raw"]))
    except UnsupportedMimeType as exc:
        await _mark_failed(conn, org_id, document_id, str(exc))
        return

    # Chunking is CPU-bound (many small tokenizer.encode calls); offloaded
    # to a thread so the event loop's other consumer loop (triage) can keep
    # making progress while this runs (ADR-0023 §4's revisit trigger is F9
    # latency, and a long ingest batch is the more likely thing to trip it -
    # see the PR body for the two-loops-one-process trade in full).
    chunk_texts = await asyncio.to_thread(chunk_markdown, text, embedder.tokenizer)
    if not chunk_texts:
        await _mark_failed(conn, org_id, document_id, "no extractable text")
        return

    # Re-ingest is delete-then-insert in this same transaction (ADR-0025
    # §2), so a crash partway through leaves the document at its previous
    # status, not half-indexed.
    await conn.execute(
        "delete from chunks where org_id = $1 and document_id = $2", org_id, document_id
    )

    for batch_start in range(0, len(chunk_texts), MAX_BATCH_SIZE):
        batch = chunk_texts[batch_start : batch_start + MAX_BATCH_SIZE]
        vectors = await asyncio.to_thread(embedder.embed_batch, batch)
        for offset, (chunk_text, vector) in enumerate(zip(batch, vectors, strict=True)):
            await conn.execute(
                "insert into chunks (org_id, document_id, ord, text, embedding) "
                "values ($1, $2, $3, $4, $5::vector)",
                org_id,
                document_id,
                batch_start + offset,
                chunk_text,
                _vector_literal(vector),
            )

    await conn.execute(
        "update documents set status = 'indexed', chunk_count = $3, error = null, "
        "text_content = $4 where org_id = $1 and id = $2",
        org_id,
        document_id,
        len(chunk_texts),
        text,
    )
