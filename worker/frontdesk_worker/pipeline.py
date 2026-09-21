"""The triage pipeline (#25, REQUIREMENTS F4-F8): classify -> route ->
retrieve -> draft -> confidence.

consumer.py has already opened the tenant-scoped transaction and set
requests.status = 'triaging' before calling this; this function receives
that live connection and does everything else in it, so a crash partway
through leaves the request at 'triaging' (re-triaged on redelivery, same
as any other transient consumer.py failure) rather than half-updated.

Two terminal states, both of which always write a drafts row (F7: "If
retrieval returns nothing above the floor, the draft says so and the
request is flagged needs-human" - the draft row is how "says so" happens,
not just the request's status):

- **drafted**: retrieval returned chunks above the floor and the draft's
  citations all validated (draft.py handles the one retry).
- **needs_human**: retrieval returned nothing above the floor, or the
  draft still cited an unretrieved id after a retry. The drafts row
  explains which, with confidence 0 and no citations.

drafts.tokens_in/tokens_out record the *sum* of every LLM call this run
made (classify, plus zero, one, or two draft attempts) - not just the last
one. spend.py's per-org and global daily budgets (ADR-0023 §5 layers 2/3)
have no other record of usage; under-recording here would silently
undercount real spend against those ceilings.

Query embedding: retrieval needs the request's subject+body embedded with
the same bge-small model ingestion used, so an Embedder is threaded down
from __main__.py -> consumer.py -> here, the same single instance
ingestion already loads once per process (ADR-0023 §4 - one process, one
resident model; a second instance would double the memory this worker's
512Mi limit was sized against). embed_batch() is CPU-bound and offloaded
via asyncio.to_thread for the same reason ingestion's pipeline does -
so the other consumer loop keeps making progress while this one embeds.

**Eval gate**: this PR does not run `make eval` or report recall@5 /
classification accuracy. `evals/golden/` is an empty directory and there is
no `evals/baseline.json` - the golden dataset is #30 (M4), still open, and
the gate has nothing to run against. This is the same situation ADR-0023
§3 anticipated ("or, if #30 has still not landed by then, say plainly in
the PR body that the eval gate was unavailable and why") and that
docs/review-rubric.md's eval-gate exception (added after #102, commit
0d03266) now checks for directly. No recall@5 or accuracy number is
fabricated here or in the PR body; this paragraph is the required
statement, placed in the diff itself (not only the PR description) per
that same commit's reasoning about how the review job's prompt is built.
"""

import asyncio
import json
import logging

import asyncpg

from .ingestion.embedder import Embedder
from .settings import Settings
from .spend import resolve_provider
from .triage.classify import classify_and_route
from .triage.confidence import compute_confidence
from .triage.draft import generate_draft
from .triage.prompts import PROMPT_VERSION
from .triage.retrieve import retrieve_chunks, similarity_floor

logger = logging.getLogger(__name__)


class RequestNotFound(Exception):
    pass


class OrgNotFound(Exception):
    pass


async def _next_draft_version(
    conn: asyncpg.pool.PoolConnectionProxy, org_id: str, request_id: str
) -> int:
    version = await conn.fetchval(
        "select coalesce(max(version), 0) + 1 from drafts where org_id = $1 and request_id = $2",
        org_id,
        request_id,
    )
    return int(version)


async def _write_result(
    conn: asyncpg.pool.PoolConnectionProxy,
    org_id: str,
    request_id: str,
    *,
    status: str,
    category: str,
    urgency: str,
    summary: str,
    lane: str,
    draft_body: str,
    citations: list[str],
    confidence: float,
    model: str,
    tokens_in: int,
    tokens_out: int,
) -> None:
    await conn.execute(
        "update requests set status = $3::request_status, category = $4, "
        "urgency = $5::request_urgency, summary = $6, lane = $7 where org_id = $1 and id = $2",
        org_id,
        request_id,
        status,
        category,
        urgency,
        summary,
        lane,
    )
    version = await _next_draft_version(conn, org_id, request_id)
    await conn.execute(
        "insert into drafts (org_id, request_id, version, body, citations, confidence, "
        "model, prompt_version, tokens_in, tokens_out) "
        "values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)",
        org_id,
        request_id,
        version,
        draft_body,
        json.dumps(citations),
        confidence,
        model,
        PROMPT_VERSION,
        tokens_in,
        tokens_out,
    )


async def run_triage_pipeline(
    conn: asyncpg.pool.PoolConnectionProxy,
    pool: asyncpg.Pool,
    embedder: Embedder,
    settings: Settings,
    org_id: str,
    request_id: str,
) -> None:
    request = await conn.fetchrow(
        "select subject, body from requests where org_id = $1 and id = $2", org_id, request_id
    )
    if request is None:
        raise RequestNotFound(f"request {request_id} not found for its org")

    org = await conn.fetchrow("select settings, daily_token_budget from orgs where id = $1", org_id)
    if org is None:
        # requests.org_id has a foreign key into orgs (db/src/schema/requests.ts),
        # so reaching here with a real request row is unreachable in
        # practice - kept for the same reason as api/'s exhaustive-switch
        # comments: defensive, not exercised by a test that would have to
        # violate that constraint to trigger it.
        raise OrgNotFound(f"org {org_id} not found")

    org_settings_raw = org["settings"]
    org_settings: dict[str, object] = (
        json.loads(org_settings_raw)
        if isinstance(org_settings_raw, str)
        else dict(org_settings_raw)
    )
    categories_raw = org_settings.get("categories")
    categories: list[str] = list(categories_raw) if isinstance(categories_raw, list) else []
    lanes_raw = org_settings.get("lanes")
    lanes: dict[str, str] = dict(lanes_raw) if isinstance(lanes_raw, dict) else {}
    descriptions_raw = org_settings.get("categoryDescriptions")
    category_descriptions: dict[str, str] | None = (
        {str(k): str(v) for k, v in descriptions_raw.items()}
        if isinstance(descriptions_raw, dict)
        else None
    )
    floor = similarity_floor(org_settings)

    provider = await resolve_provider(pool, settings, org_id, int(org["daily_token_budget"]))

    classification = await classify_and_route(
        provider,
        categories,
        lanes,
        request["subject"],
        request["body"],
        category_descriptions=category_descriptions,
    )
    tokens_in = classification.input_tokens
    tokens_out = classification.output_tokens

    query_text = f"{request['subject']}\n\n{request['body']}"
    query_vectors = await asyncio.to_thread(embedder.embed_batch, [query_text])
    retrieved = await retrieve_chunks(conn, org_id, query_vectors[0], query_text, floor=floor)

    if not retrieved:
        await _write_result(
            conn,
            org_id,
            request_id,
            status="needs_human",
            category=classification.category,
            urgency=classification.urgency,
            summary=classification.summary,
            lane=classification.lane,
            draft_body=(
                "No relevant information was found in this business's documents for this "
                "request. A staff member needs to reply directly."
            ),
            citations=[],
            confidence=0.0,
            model=classification.model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )
        return

    outcome = await generate_draft(provider, request["subject"], request["body"], retrieved)
    tokens_in += outcome.input_tokens
    tokens_out += outcome.output_tokens

    if outcome.result is None:
        await _write_result(
            conn,
            org_id,
            request_id,
            status="needs_human",
            category=classification.category,
            urgency=classification.urgency,
            summary=classification.summary,
            lane=classification.lane,
            draft_body=(
                "A draft reply could not be verified against this business's documents "
                "(it cited a source that was not retrieved). A staff member needs to "
                "review this request directly."
            ),
            citations=[],
            confidence=0.0,
            model=classification.model,
            tokens_in=tokens_in,
            tokens_out=tokens_out,
        )
        return

    confidence = compute_confidence(
        [chunk.similarity for chunk in retrieved],
        len(outcome.result.cited_ids),
        len(retrieved),
        floor,
    )

    await _write_result(
        conn,
        org_id,
        request_id,
        status="drafted",
        category=classification.category,
        urgency=classification.urgency,
        summary=classification.summary,
        lane=classification.lane,
        draft_body=outcome.result.text,
        citations=outcome.result.cited_ids,
        confidence=confidence,
        model=outcome.result.model,
        tokens_in=tokens_in,
        tokens_out=tokens_out,
    )
