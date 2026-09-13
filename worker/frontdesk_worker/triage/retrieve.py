"""F6: hybrid retrieval - pgvector cosine ANN (chunks_embedding_hnsw) fused
with Postgres full-text search (chunks_tsv_gin's generated tsv column via
ts_rank_cd) using reciprocal rank fusion (k=60), top-5 above a cosine
similarity floor (ADR-0005). The floor is `org.settings.similarityFloor`
when the org set one, else DEFAULT_SIMILARITY_FLOOR - ADR-0005 calls the
floor "tunable per org" and db/src/settings.ts's orgSettingsSchema already
has the field; nothing here invents it.

Every query filters by org_id explicitly (AGENTS.md: "Every query on a
tenant table includes org_id. No exceptions"), on top of RLS.
"""

from collections.abc import Sequence
from dataclasses import dataclass

import asyncpg
import numpy as np

RRF_K = 60
CANDIDATE_LIMIT = 20
RESULT_LIMIT = 5
DEFAULT_SIMILARITY_FLOOR = 0.35


@dataclass(frozen=True)
class RetrievedChunk:
    id: str
    text: str
    similarity: float


def similarity_floor(org_settings: dict[str, object]) -> float:
    value = org_settings.get("similarityFloor", DEFAULT_SIMILARITY_FLOOR)
    return float(value) if isinstance(value, int | float) else DEFAULT_SIMILARITY_FLOOR


def _vector_literal(vector: Sequence[float] | np.ndarray) -> str:
    # Same approach as ingestion/pipeline.py's _vector_literal: asyncpg has
    # no built-in codec for pgvector's type, so the vector travels as text
    # and is cast server-side (`$n::vector`).
    return "[" + ",".join(str(float(x)) for x in vector) + "]"


async def retrieve_chunks(
    conn: asyncpg.pool.PoolConnectionProxy,
    org_id: str,
    query_embedding: Sequence[float] | np.ndarray,
    query_text: str,
    *,
    floor: float = DEFAULT_SIMILARITY_FLOOR,
    candidate_limit: int = CANDIDATE_LIMIT,
    result_limit: int = RESULT_LIMIT,
    rrf_k: int = RRF_K,
) -> list[RetrievedChunk]:
    vector_literal = _vector_literal(query_embedding)

    cosine_rows = await conn.fetch(
        "select id, text, 1 - (embedding <=> $2::vector) as score from chunks "
        "where org_id = $1 and embedding is not null "
        "order by embedding <=> $2::vector limit $3",
        org_id,
        vector_literal,
        candidate_limit,
    )
    # OR-joining the query's own lexemes, not plainto_tsquery(): that
    # function AND-joins every lexeme, so a real multi-sentence request
    # (subject + body, ~15-20 significant words) becomes a conjunction no
    # chunk can ever satisfy - the FTS arm silently returns zero rows and
    # RRF degenerates to cosine-only. ts_rank_cd is what should discriminate
    # relevance here; the tsquery only needs to pick a *candidate set*, the
    # same job plainto_tsquery was wrongly also using it to filter down to
    # nothing. A query that reduces to zero lexemes (pure stopwords/
    # punctuation) produces an empty tsquery, which matches nothing rather
    # than raising - the `<> ''` guard makes that explicit rather than
    # relying on `@@` against an empty tsquery to happen to behave that way.
    fts_rows = await conn.fetch(
        "with q as ("
        "  select to_tsquery('english', array_to_string("
        "    tsvector_to_array(to_tsvector('english', $2)), ' | '"
        "  )) as tsq"
        ") "
        "select c.id, c.text, ts_rank_cd(c.tsv, q.tsq) as score "
        "from chunks c cross join q "
        "where c.org_id = $1 and q.tsq::text <> '' and c.tsv @@ q.tsq "
        "order by score desc limit $3",
        org_id,
        query_text,
        candidate_limit,
    )

    rrf_scores: dict[str, float] = {}
    text_by_id: dict[str, str] = {}
    for rank, row in enumerate(cosine_rows, start=1):
        key = str(row["id"])
        rrf_scores[key] = rrf_scores.get(key, 0.0) + 1 / (rrf_k + rank)
        text_by_id[key] = row["text"]
    for rank, row in enumerate(fts_rows, start=1):
        key = str(row["id"])
        rrf_scores[key] = rrf_scores.get(key, 0.0) + 1 / (rrf_k + rank)
        text_by_id[key] = row["text"]

    if not rrf_scores:
        return []

    similarity_by_id = {str(row["id"]): float(row["score"]) for row in cosine_rows}
    # A chunk that only surfaced via full-text has no cosine score yet, but
    # the floor is a cosine floor (ADR-0005) - fetch it directly rather than
    # treating "not in the cosine top-20" as "similarity 0" by assumption.
    missing_ids = [key for key in rrf_scores if key not in similarity_by_id]
    if missing_ids:
        extra_rows = await conn.fetch(
            "select id, 1 - (embedding <=> $1::vector) as score from chunks "
            "where org_id = $2 and id = any($3::uuid[]) and embedding is not null",
            vector_literal,
            org_id,
            missing_ids,
        )
        for row in extra_rows:
            similarity_by_id[str(row["id"])] = float(row["score"])

    ranked_ids = sorted(rrf_scores, key=lambda key: rrf_scores[key], reverse=True)
    above_floor = [
        RetrievedChunk(id=key, text=text_by_id[key], similarity=similarity_by_id.get(key, 0.0))
        for key in ranked_ids
        if similarity_by_id.get(key, 0.0) >= floor
    ]
    return above_floor[:result_limit]
