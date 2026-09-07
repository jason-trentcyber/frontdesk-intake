# ADR-0005: Hybrid retrieval on pgvector with in-process embeddings

Status: decided 2026-09-07

## Decision
- Embedding model: `BAAI/bge-small-en-v1.5` (384 dims) run in the Python worker via `sentence-transformers` on CPU. ~130 MB, ~20 ms per chunk on 4 vCPU.
- Chunking: Markdown-aware splitter, 400-token target, 60-token overlap, headings carried into each chunk as prefix. PDFs are text-extracted then treated as Markdown.
- Storage: `chunks(org_id, doc_id, ord, text, tsv tsvector, embedding vector(384))`. HNSW index on `embedding` with `m=16, ef_construction=64`, cosine distance. GIN on `tsv`. Both indexes partial per nothing; RLS scopes by `org_id`, and queries always filter by `org_id` first.
- Query: top-20 by cosine, top-20 by `ts_rank_cd`, fused with reciprocal rank fusion (k=60), return top-5 above a cosine floor of 0.35. Floor is tunable per org.
- Citations: draft prompt receives chunks as `[c:<id>]` blocks and must emit the ids it relied on; the worker rejects a draft that cites unknown ids.
- `/api/v1/orgs/<slug>/index-info` exposes model, dims, index params, chunk count.

## Why these choices
- Small local model keeps embeddings free and vendor-independent; 384 dims halves index size and query time versus 768/1536 with negligible recall loss at this corpus size (hundreds of chunks per org).
- Hybrid search catches exact terms (insurance plan names, phone numbers) that dense retrieval misses.
- pgvector over a separate vector DB: one datastore, one backup, transactional consistency with the rest of the org's data.

## Consequences
- Swapping to a hosted embedding model changes dims and requires a reindex; a `reindex` job exists for that.
- The eval gate (ADR-0008) measures recall@5 so retrieval regressions are caught.

## Rejected
- Hosted embeddings (OpenAI, Titan): cost is trivial but adds a vendor to the core path and hides the decisions this project wants to show.
- Dedicated vector DB (Qdrant, Weaviate): another service on a small node, and cross-store consistency work.
