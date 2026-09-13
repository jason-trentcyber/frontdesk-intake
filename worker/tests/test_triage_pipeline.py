import statistics
import time
import uuid
from dataclasses import dataclass, field

import asyncpg
import pytest
from conftest import OrgFactory, requires_postgres

from frontdesk_worker import pipeline as pipeline_module
from frontdesk_worker.db import for_org
from frontdesk_worker.ingestion.embedder import Embedder, ModelNotFetched
from frontdesk_worker.pipeline import RequestNotFound, run_triage_pipeline
from frontdesk_worker.settings import Settings
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
        assert draft["prompt_version"] == "triage-v1"
        assert draft["model"] == "haiku"
        assert draft["tokens_in"] > 0
        assert draft["tokens_out"] > 0


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
