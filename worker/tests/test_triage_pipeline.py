import statistics
import time
import uuid
from dataclasses import dataclass, field

import asyncpg
import numpy as np
import pytest
from conftest import OrgFactory, requires_postgres

from frontdesk_worker import pipeline as pipeline_module
from frontdesk_worker.db import for_org
from frontdesk_worker.ingestion.embedder import Embedder, ModelNotFetched
from frontdesk_worker.pipeline import RequestNotFound, run_triage_pipeline
from frontdesk_worker.settings import Settings
from frontdesk_worker.triage.prompts import PROMPT_VERSION
from llm import Completion, Message

try:
    _embedder = Embedder()
except ModelNotFetched:
    _embedder = None

requires_model = pytest.mark.skipif(
    _embedder is None,
    reason="worker/models/bge-small-en-v1.5/ not fetched - run `uv run python scripts/fetch_model.py`",
)

_ORG_SETTINGS = {
    "categories": ["scheduling", "billing", "other"],
    "lanes": {"scheduling": "front-desk", "billing": "billing", "other": "front-desk"},
}


def _settings(**overrides: object) -> Settings:
    base: dict[str, object] = {
        "database_url": "unused",
        "queue_provider": "pgmq",
        "llm_provider": "fake",
        "llm_model": "haiku",
        "visibility_timeout_seconds": 15,
        "max_delivery_attempts": 5,
        "global_daily_spend_ceiling_usd": 1.0,
        "aws_region": None,
        "aws_endpoint_url": None,
        "sqs_queue_url": None,
        "sqs_dlq_url": None,
        "ingest_sqs_queue_url": None,
        "ingest_sqs_dlq_url": None,
    }
    base.update(overrides)
    return Settings(**base)  # type: ignore[arg-type]


@dataclass
class _AlwaysCitesAnInvalidId:
    """A provider double whose classify response is valid JSON, but whose
    draft response always cites an id nothing retrieved - forces the
    needs_human-via-bad-citation path (draft.py's two-attempt retry, then
    give up) through the *real* pipeline, not just draft.py's own unit
    tests.
    """

    calls: list[str] = field(default_factory=list)

    async def complete(
        self, messages: list[Message], *, tools: object = None, max_tokens: int, temperature: float
    ) -> Completion:
        prompt = messages[0].content
        self.calls.append(prompt)
        if "category" in prompt.lower() and "urgency" in prompt.lower():
            text = '{"category": "other", "urgency": "normal", "summary": "a question"}'
        else:
            text = "This cites a source. [c:not-a-real-chunk-id]"
        return Completion(
            text=text,
            input_tokens=10,
            output_tokens=5,
            finish_reason="stop",
            cost_usd=0.0,
            provider="test",
            model="test-model",
        )


@dataclass
class _RecordingProvider:
    """Records every prompt verbatim and returns a valid, citation-free
    classify+draft pair - used to inspect what draft.py actually rendered
    into the draft prompt (every retrieved chunk's own text, via
    _render_chunks), without needing retrieve_chunks() to return anything
    directly to the test.
    """

    calls: list[str] = field(default_factory=list)

    async def complete(
        self, messages: list[Message], *, tools: object = None, max_tokens: int, temperature: float
    ) -> Completion:
        prompt = messages[0].content
        self.calls.append(prompt)
        if "category" in prompt.lower() and "urgency" in prompt.lower():
            text = '{"category": "other", "urgency": "normal", "summary": "a question"}'
        else:
            text = "Thanks for reaching out - a staff member will follow up."
        return Completion(
            text=text,
            input_tokens=10,
            output_tokens=5,
            finish_reason="stop",
            cost_usd=0.0,
            provider="test",
            model="test-model",
        )


@requires_postgres
@requires_model
async def test_no_relevant_chunks_marks_needs_human_and_still_writes_a_draft_row(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org(settings=_ORG_SETTINGS)
    request_id = await org_factory.make_request(org_id, subject="Refund question")

    async with for_org(app_pool, org_id) as conn:
        # LLM_PROVIDER=fake (the manual killswitch, ADR-0023 §5) - no
        # network, deterministic, and this is the path a real global-ceiling
        # breach downgrades to as well.
        await run_triage_pipeline(conn, app_pool, _embedder, _settings(), org_id, request_id)

        request = await conn.fetchrow(
            "select status, category, urgency, summary, lane from requests where id = $1",
            request_id,
        )
        assert request is not None
        assert request["status"] == "needs_human"
        # Classification still ran and wrote something - only retrieval was
        # empty (no chunks exist for this org at all).
        assert request["category"] in _ORG_SETTINGS["categories"]
        assert request["lane"]

        draft = await conn.fetchrow(
            "select confidence, citations, tokens_in, tokens_out from drafts where request_id = $1",
            request_id,
        )
        assert draft is not None
        assert float(draft["confidence"]) == 0.0
        assert draft["citations"] == "[]" or draft["citations"] == []
        assert draft["tokens_in"] > 0  # the classify call still cost tokens


@requires_postgres
@requires_model
async def test_happy_path_with_relevant_chunks_writes_drafted_status(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org(settings=_ORG_SETTINGS)
    request_id = await org_factory.make_request(
        org_id, subject="How often should I get a cleaning?"
    )
    doc_id = await org_factory.make_document(org_id)
    text = "Cleanings are recommended every six months for most patients."
    await org_factory.make_chunk(
        org_id, doc_id, ord=0, text=text, embedding=list(_embedder.embed_batch([text])[0])
    )

    async with for_org(app_pool, org_id) as conn:
        await run_triage_pipeline(conn, app_pool, _embedder, _settings(), org_id, request_id)

        request = await conn.fetchrow("select status from requests where id = $1", request_id)
        assert request is not None
        # FakeProvider's echoed response never carries a real [c:...]
        # citation, so retrieval succeeding but the fake draft citing
        # nothing is still an *honest* drafted state (not needs_human) -
        # zero citations is trivially valid, not an error (draft.py).
        assert request["status"] == "drafted"

        draft = await conn.fetchrow(
            "select prompt_version, model, tokens_in, tokens_out from drafts where request_id = $1",
            request_id,
        )
        assert draft is not None
        assert draft["prompt_version"] == PROMPT_VERSION
        assert draft["model"] == "haiku"
        assert draft["tokens_in"] > 0
        assert draft["tokens_out"] > 0


@requires_postgres
@requires_model
async def test_full_text_arm_surfaces_a_chunk_pure_cosine_would_have_excluded(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Regression for #105's review finding: retrieve.py's FTS query used to
    call plainto_tsquery(), which AND-joins every lexeme in the query text -
    a real multi-sentence subject+body becomes a ~15-20-term conjunction no
    chunk can ever satisfy, so the FTS arm silently returned zero rows and
    RRF degenerated to cosine-only. The unit test that existed before this
    one (test_retrieve.py::test_full_text_only_match_is_still_found_via_rrf)
    called retrieve_chunks() directly with a hand-written 3-word phrase, so
    it never exercised the sentence the real pipeline actually builds - this
    test calls run_triage_pipeline() itself, with a realistic multi-sentence
    body, which is the only way to have caught the bug.

    Six chunks: five "decoy" chunks whose real bge-small embeddings all rank
    above a sixth "keyword" chunk on cosine similarity alone (verified
    empirically while writing this test - see the PR body) - a cosine-only
    top-5 excludes the keyword chunk entirely. The keyword chunk's *text*
    contains the query's one distinctive, rare phrase; nothing else does.
    Its *embedding* is deliberately reassigned to a moderate, lower-than-all-
    five-decoys value (borrowed from an unrelated sentence's real embedding)
    rather than left as its own naturally-computed one: empirically, bge-small
    gives very high cosine similarity to any chunk sharing an exact rare
    phrase with the query, which makes it hard to construct a *realistic*
    chunk that both contains the phrase and ranks low on cosine - the
    reassignment isolates the mechanism under test (does FTS rescue a chunk
    cosine ranks out of the top-5?) from that embedding-space property,
    which would otherwise make the scenario unreproducible with organically
    computed vectors. The chunk's *text* - what full-text search actually
    indexes - is exactly what ingestion would have produced for a real
    document containing that sentence.
    """
    assert _embedder is not None
    org_id = await org_factory.make_org(settings=_ORG_SETTINGS)
    subject = "Cleaning appointment and insurance question"
    body = (
        "Hi, I would like to book a routine cleaning appointment soon. I also "
        "wanted to double check something unrelated: does your office "
        "participate in the Zenith Advantage discount program my employer offers?"
    )
    request_id = await org_factory.make_request(org_id, subject=subject, body=body)
    doc_id = await org_factory.make_document(org_id)

    decoy_texts = [
        "A routine cleaning is recommended every six months for most patients and takes about 45 minutes.",
        "Cleanings include scaling, polishing, and a fluoride treatment on request.",
        "Most insurance plans cover two cleanings per calendar year at 100 percent.",
        "You can schedule your next cleaning appointment online or by calling the front desk.",
        "We recommend patients book cleanings in advance since appointment slots fill up quickly.",
    ]
    keyword_text = (
        "Please note: the Zenith Advantage discount program does not apply to "
        "holiday emergency visits."
    )
    # Borrowed from an unrelated sentence's real embedding, deliberately NOT
    # one of the decoys' own vectors (a tie would make "weakest decoy
    # excluded" below ambiguous) - see the docstring for why the keyword
    # chunk does not keep its own naturally-computed embedding.
    reassigned_embedding = list(
        _embedder.embed_batch(
            ["Our fillings use tooth-colored composite material for both front and back teeth."]
        )[0]
    )

    query_text = f"{subject}\n\n{body}"
    query_vector = _embedder.embed_batch([query_text])[0]
    decoy_vectors = _embedder.embed_batch(decoy_texts)
    decoy_sims = sorted(float(np.dot(query_vector, v)) for v in decoy_vectors)
    keyword_sim = float(np.dot(query_vector, reassigned_embedding))
    assert keyword_sim <= min(decoy_sims), (
        "test setup invariant broken: the keyword chunk's (reassigned) cosine "
        "similarity must rank below every decoy for this test to prove anything"
    )

    for i, text in enumerate(decoy_texts):
        await org_factory.make_chunk(
            org_id, doc_id, ord=i, text=text, embedding=list(decoy_vectors[i])
        )
    await org_factory.make_chunk(
        org_id, doc_id, ord=len(decoy_texts), text=keyword_text, embedding=reassigned_embedding
    )

    provider = _RecordingProvider()

    async def fake_resolve_provider(*args: object, **kwargs: object) -> _RecordingProvider:
        return provider

    monkeypatch.setattr(pipeline_module, "resolve_provider", fake_resolve_provider)

    async with for_org(app_pool, org_id) as conn:
        await run_triage_pipeline(conn, app_pool, _embedder, _settings(), org_id, request_id)

    assert len(provider.calls) == 2
    draft_prompt = provider.calls[1]
    assert keyword_text in draft_prompt, (
        "the FTS arm should have surfaced the keyword chunk despite its low "
        "cosine rank - if this fails, RRF/retrieve_chunks regressed to "
        "cosine-only again (e.g. plainto_tsquery's AND semantics, #105)"
    )
    # RESULT_LIMIT is 5 and there are 6 chunks total, so the keyword chunk's
    # presence necessarily displaced exactly one decoy - which one depends
    # on each decoy's own ts_rank_cd (several decoys share generic query
    # words like "clean"/"appointment" too, not just the keyword chunk, so
    # this is deliberately not asserting *which* one to avoid pinning down
    # ts_rank_cd's internal weighting instead of the thing this test is
    # actually about: that the keyword chunk - dead last on cosine alone -
    # made the cut at all.
    missing_decoys = [text for text in decoy_texts if text not in draft_prompt]
    assert len(missing_decoys) == 1, (
        f"expected exactly one decoy displaced by the keyword chunk, got {missing_decoys!r}"
    )


@requires_postgres
@requires_model
async def test_missing_request_raises_request_not_found(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org(settings=_ORG_SETTINGS)

    async with for_org(app_pool, org_id) as conn:
        with pytest.raises(RequestNotFound):
            await run_triage_pipeline(
                conn, app_pool, _embedder, _settings(), org_id, str(uuid.uuid4())
            )


@requires_postgres
@requires_model
async def test_persistent_invalid_citation_marks_needs_human(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert _embedder is not None
    org_id = await org_factory.make_org(settings=_ORG_SETTINGS)
    request_id = await org_factory.make_request(
        org_id, subject="How often should I get a cleaning?"
    )
    doc_id = await org_factory.make_document(org_id)
    text = "Cleanings are recommended every six months for most patients."
    await org_factory.make_chunk(
        org_id, doc_id, ord=0, text=text, embedding=list(_embedder.embed_batch([text])[0])
    )

    provider = _AlwaysCitesAnInvalidId()

    async def fake_resolve_provider(*args: object, **kwargs: object) -> _AlwaysCitesAnInvalidId:
        return provider

    monkeypatch.setattr(pipeline_module, "resolve_provider", fake_resolve_provider)

    async with for_org(app_pool, org_id) as conn:
        await run_triage_pipeline(conn, app_pool, _embedder, _settings(), org_id, request_id)

        request = await conn.fetchrow("select status from requests where id = $1", request_id)
        assert request is not None
        assert request["status"] == "needs_human"

        draft = await conn.fetchrow(
            "select confidence, citations, tokens_in, tokens_out from drafts where request_id = $1",
            request_id,
        )
        assert draft is not None
        assert float(draft["confidence"]) == 0.0
        # classify (1 call) + draft (2 attempts, both invalid) = 3 calls,
        # tokens from all three counted.
        assert len(provider.calls) == 3
        assert draft["tokens_in"] == 30
        assert draft["tokens_out"] == 15


@requires_postgres
@requires_model
async def test_draft_written_for_org_a_is_invisible_under_org_b(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org(settings=_ORG_SETTINGS)
    org_b = await org_factory.make_org(settings=_ORG_SETTINGS)
    request_id = await org_factory.make_request(org_a)
    assert _embedder is not None

    async with for_org(app_pool, org_a) as conn:
        await run_triage_pipeline(conn, app_pool, _embedder, _settings(), org_a, request_id)

    async with for_org(app_pool, org_b) as conn:
        rows = await conn.fetch("select id from drafts where request_id = $1", request_id)

    assert rows == []


@requires_postgres
async def test_cross_org_draft_insert_raises_the_rls_violation(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    org_a = await org_factory.make_org()
    org_b = await org_factory.make_org()
    request_id = await org_factory.make_request(org_b)

    with pytest.raises(asyncpg.InsufficientPrivilegeError, match="row-level security policy"):
        async with for_org(app_pool, org_a) as conn:
            await conn.execute(
                "insert into drafts (org_id, request_id, version, body, confidence, model, "
                "prompt_version) values ($1, $2, 1, 'x', 0, 'm', 'v')",
                org_b,
                request_id,
            )


@requires_postgres
@requires_model
async def test_p95_draft_latency_with_the_fake_provider(
    app_pool: asyncpg.Pool, org_factory: OrgFactory
) -> None:
    """Measures the pipeline's own overhead (DB reads/writes, embedding,
    retrieval SQL, JSON parsing) end to end with a real Postgres and a real
    Embedder - everything this PR's code controls. LLM_PROVIDER=fake means
    this figure deliberately EXCLUDES real OpenRouter network latency: no
    test may call OpenRouter (AGENTS.md), and there is no API key in this
    environment to do so even outside the test suite. F9's 10s p95 target
    is dominated by two real LLM round-trips (classify + draft) against a
    live model, which this measurement cannot include - see the PR body
    for the actual measured number and what it does and does not establish.

    Also does not establish retrieval cost at realistic corpus size: this
    org has exactly one chunk, so the HNSW index scan (chunks_embedding_hnsw)
    and the full-text scan are both effectively O(1) against a single-row
    table. This is a regression guard against the pipeline's own
    orchestration overhead regressing, not a measurement of retrieval
    latency against the hundreds of chunks a real org's document set would
    produce.
    """
    assert _embedder is not None
    org_id = await org_factory.make_org(settings=_ORG_SETTINGS)
    doc_id = await org_factory.make_document(org_id)
    text = "Cleanings are recommended every six months for most patients."
    await org_factory.make_chunk(
        org_id, doc_id, ord=0, text=text, embedding=list(_embedder.embed_batch([text])[0])
    )

    durations: list[float] = []
    for _ in range(20):
        request_id = await org_factory.make_request(org_id, subject="cleaning question")
        started = time.monotonic()
        async with for_org(app_pool, org_id) as conn:
            await run_triage_pipeline(conn, app_pool, _embedder, _settings(), org_id, request_id)
        durations.append(time.monotonic() - started)

    durations.sort()
    p95 = statistics.quantiles(durations, n=100)[94]
    print(
        f"\np95 pipeline latency over {len(durations)} runs (LLM_PROVIDER=fake): {p95 * 1000:.1f}ms"
    )

    # Generous relative to what was actually measured locally (see PR body)
    # - this is a regression guard, not a tuned SLA number.
    assert p95 < 2.0
