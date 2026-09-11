import asyncio
from dataclasses import dataclass, field

import asyncpg
import pytest
from conftest import OrgFactory, requires_postgres

from frontdesk_worker import consumer
from frontdesk_worker.db import for_org
from frontdesk_worker.ingestion.pipeline import DocumentNotFound
from frontdesk_worker.queue import QueueMessage


@dataclass
class FakeQueue:
    """In-memory Queue double - same shape as requests.test.ts's FakeQueue on
    the TS side. One pending message at a time is enough for these tests.
    """

    pending: list[QueueMessage] = field(default_factory=list)
    acked: list[str] = field(default_factory=list)
    nacked: list[str] = field(default_factory=list)
    dead_lettered: list[str] = field(default_factory=list)

    async def send(self, payload: object) -> str:
        raise NotImplementedError

    async def receive(self, visibility_timeout: int, qty: int = 1) -> list[QueueMessage]:
        if not self.pending:
            return []
        return [self.pending.pop(0)]

    async def ack(self, msg_id: str) -> None:
        self.acked.append(msg_id)

    async def nack(self, msg_id: str) -> None:
        self.nacked.append(msg_id)

    async def dead_letter(self, msg_id: str) -> None:
        self.dead_lettered.append(msg_id)


@requires_postgres
async def test_invalid_message_is_dead_lettered_not_retried(
    app_pool: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    called = False

    async def fail_if_called(*args: object, **kwargs: object) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(consumer, "run_triage_pipeline", fail_if_called)

    queue = FakeQueue(pending=[QueueMessage(id="1", body={"orgId": "x"}, delivery_attempt=1)])

    got_message = await consumer.process_one(
        queue, app_pool, visibility_timeout=15, max_delivery_attempts=5
    )

    assert got_message is True
    assert queue.dead_lettered == ["1"]
    assert queue.acked == []
    assert queue.nacked == []
    assert called is False


@requires_postgres
async def test_valid_message_calls_the_pipeline_seam_and_sets_status_triaging(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    org_id = await org_factory.make_org()
    request_id = await org_factory.make_request(org_id)

    calls: list[tuple[str, str]] = []

    async def record_call(conn: object, queue: object, org_id: str, request_id: str) -> None:
        calls.append((org_id, request_id))

    monkeypatch.setattr(consumer, "run_triage_pipeline", record_call)

    queue = FakeQueue(
        pending=[
            QueueMessage(
                id="1", body={"orgId": org_id, "requestId": request_id}, delivery_attempt=1
            )
        ]
    )

    await consumer.process_one(queue, app_pool, visibility_timeout=15, max_delivery_attempts=5)

    assert calls == [(org_id, request_id)]
    assert queue.acked == ["1"]
    assert queue.nacked == []
    assert queue.dead_lettered == []

    async with for_org(app_pool, org_id) as conn:
        status = await conn.fetchval("select status from requests where id = $1", request_id)
    assert status == "triaging"


@requires_postgres
async def test_pipeline_failure_below_the_retry_ceiling_nacks(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    org_id = await org_factory.make_org()
    request_id = await org_factory.make_request(org_id)

    async def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("transient")

    monkeypatch.setattr(consumer, "run_triage_pipeline", boom)

    queue = FakeQueue(
        pending=[
            QueueMessage(
                id="1", body={"orgId": org_id, "requestId": request_id}, delivery_attempt=1
            )
        ]
    )

    await consumer.process_one(queue, app_pool, visibility_timeout=15, max_delivery_attempts=5)

    assert queue.nacked == ["1"]
    assert queue.dead_lettered == []
    assert queue.acked == []


@requires_postgres
async def test_pipeline_failure_at_the_retry_ceiling_dead_letters(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    org_id = await org_factory.make_org()
    request_id = await org_factory.make_request(org_id)

    async def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("still failing")

    monkeypatch.setattr(consumer, "run_triage_pipeline", boom)

    queue = FakeQueue(
        pending=[
            QueueMessage(
                id="1", body={"orgId": org_id, "requestId": request_id}, delivery_attempt=5
            )
        ]
    )

    await consumer.process_one(queue, app_pool, visibility_timeout=15, max_delivery_attempts=5)

    assert queue.dead_lettered == ["1"]
    assert queue.nacked == []
    assert queue.acked == []


@requires_postgres
async def test_empty_queue_returns_false(app_pool: asyncpg.Pool) -> None:
    queue = FakeQueue(pending=[])

    got_message = await consumer.process_one(
        queue, app_pool, visibility_timeout=15, max_delivery_attempts=5
    )

    assert got_message is False


async def test_the_real_pipeline_stub_raises_not_implemented() -> None:
    from frontdesk_worker.pipeline import run_triage_pipeline

    with pytest.raises(NotImplementedError):
        await run_triage_pipeline(None, None, "org-1", "req-1")  # type: ignore[arg-type]


async def test_run_forever_stops_promptly_with_no_further_receives_after_shutdown() -> None:
    """run_forever's loop condition (`while not shutdown.is_set()`) must be
    re-checked before every receive(), not just once at startup - otherwise
    SIGTERM (consumer.py's whole reason for the shutdown Event) would never
    actually stop the loop. Sets shutdown from inside receive() itself, on
    the Nth call, so the assertion on receive_calls proves no (N+1)th
    receive happens once shutdown is set - not just that the coroutine
    eventually returns.

    No Postgres needed: receive() always returns an empty list, so
    process_one() returns False before ever touching the pool - a sentinel
    stands in for it, same as test_queue_create.py's pattern.
    """
    shutdown = asyncio.Event()
    receive_calls = 0

    queue = FakeQueue()

    async def counting_receive(visibility_timeout: int, qty: int = 1) -> list[QueueMessage]:
        nonlocal receive_calls
        receive_calls += 1
        if receive_calls >= 3:
            shutdown.set()
        return []

    queue.receive = counting_receive  # type: ignore[method-assign]

    # wait_for is the "returns promptly" assertion: a regression that drops
    # the shutdown check would hang here instead of failing cleanly.
    await asyncio.wait_for(
        consumer.run_forever(
            queue,
            "not-a-real-pool",  # type: ignore[arg-type]
            shutdown,
            poll_interval_seconds=0.01,
        ),
        timeout=2.0,
    )

    assert receive_calls == 3


# process_one_ingest / run_forever_ingest (ADR-0025 §1) - the ingest-queue
# twin of every test above. "embedder" is never a real Embedder in these:
# run_ingestion_pipeline is monkeypatched out, same as run_triage_pipeline
# above, so these test the consumer wiring, not the pipeline (that's
# test_ingestion_pipeline.py's job).


@requires_postgres
async def test_ingest_invalid_message_is_dead_lettered_not_retried(
    app_pool: asyncpg.Pool, monkeypatch: pytest.MonkeyPatch
) -> None:
    called = False

    async def fail_if_called(*args: object, **kwargs: object) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(consumer, "run_ingestion_pipeline", fail_if_called)

    queue = FakeQueue(pending=[QueueMessage(id="1", body={"orgId": "x"}, delivery_attempt=1)])

    got_message = await consumer.process_one_ingest(
        queue,
        app_pool,
        object(),  # type: ignore[arg-type]
        visibility_timeout=15,
        max_delivery_attempts=5,
    )

    assert got_message is True
    assert queue.dead_lettered == ["1"]
    assert queue.acked == []
    assert queue.nacked == []
    assert called is False


@requires_postgres
async def test_ingest_valid_message_calls_the_pipeline_and_acks(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    org_id = await org_factory.make_org()
    document_id = await org_factory.make_document(org_id)

    calls: list[tuple[str, str]] = []

    async def record_call(conn: object, embedder: object, org_id: str, document_id: str) -> None:
        calls.append((org_id, document_id))

    monkeypatch.setattr(consumer, "run_ingestion_pipeline", record_call)

    queue = FakeQueue(
        pending=[
            QueueMessage(
                id="1", body={"orgId": org_id, "documentId": document_id}, delivery_attempt=1
            )
        ]
    )

    await consumer.process_one_ingest(
        queue,
        app_pool,
        object(),  # type: ignore[arg-type]
        visibility_timeout=15,
        max_delivery_attempts=5,
    )

    assert calls == [(org_id, document_id)]
    assert queue.acked == ["1"]
    assert queue.nacked == []
    assert queue.dead_lettered == []


@requires_postgres
async def test_ingest_pipeline_failure_below_the_retry_ceiling_nacks(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    org_id = await org_factory.make_org()
    document_id = await org_factory.make_document(org_id)

    async def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("transient")

    monkeypatch.setattr(consumer, "run_ingestion_pipeline", boom)

    queue = FakeQueue(
        pending=[
            QueueMessage(
                id="1", body={"orgId": org_id, "documentId": document_id}, delivery_attempt=1
            )
        ]
    )

    await consumer.process_one_ingest(
        queue,
        app_pool,
        object(),  # type: ignore[arg-type]
        visibility_timeout=15,
        max_delivery_attempts=5,
    )

    assert queue.nacked == ["1"]
    assert queue.dead_lettered == []
    assert queue.acked == []


@requires_postgres
async def test_ingest_document_not_found_nacks_like_any_other_pipeline_failure(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    """DocumentNotFound isn't special-cased by process_one_ingest - it falls
    into the same generic `except Exception` as any other pipeline failure
    and nacks for redelivery, exactly like test_ingest_pipeline_failure_
    below_the_retry_ceiling_nacks above with a RuntimeError. Worth pinning
    on its own name so a future change that tries to ack or dead-letter it
    specially breaks a test, not just a code review.
    """
    org_id = await org_factory.make_org()
    document_id = await org_factory.make_document(org_id)

    async def boom(*args: object, **kwargs: object) -> None:
        raise DocumentNotFound(document_id)

    monkeypatch.setattr(consumer, "run_ingestion_pipeline", boom)

    queue = FakeQueue(
        pending=[
            QueueMessage(
                id="1", body={"orgId": org_id, "documentId": document_id}, delivery_attempt=1
            )
        ]
    )

    await consumer.process_one_ingest(
        queue,
        app_pool,
        object(),  # type: ignore[arg-type]
        visibility_timeout=15,
        max_delivery_attempts=5,
    )

    assert queue.nacked == ["1"]
    assert queue.dead_lettered == []
    assert queue.acked == []


@requires_postgres
async def test_ingest_pipeline_failure_at_the_retry_ceiling_dead_letters(
    app_pool: asyncpg.Pool, org_factory: OrgFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    org_id = await org_factory.make_org()
    document_id = await org_factory.make_document(org_id)

    async def boom(*args: object, **kwargs: object) -> None:
        raise RuntimeError("still failing")

    monkeypatch.setattr(consumer, "run_ingestion_pipeline", boom)

    queue = FakeQueue(
        pending=[
            QueueMessage(
                id="1", body={"orgId": org_id, "documentId": document_id}, delivery_attempt=5
            )
        ]
    )

    await consumer.process_one_ingest(
        queue,
        app_pool,
        object(),  # type: ignore[arg-type]
        visibility_timeout=15,
        max_delivery_attempts=5,
    )

    assert queue.dead_lettered == ["1"]
    assert queue.nacked == []
    assert queue.acked == []


@requires_postgres
async def test_ingest_empty_queue_returns_false(app_pool: asyncpg.Pool) -> None:
    queue = FakeQueue(pending=[])

    got_message = await consumer.process_one_ingest(
        queue,
        app_pool,
        object(),  # type: ignore[arg-type]
        visibility_timeout=15,
        max_delivery_attempts=5,
    )

    assert got_message is False


async def test_run_forever_ingest_stops_promptly_with_no_further_receives_after_shutdown() -> None:
    shutdown = asyncio.Event()
    receive_calls = 0

    queue = FakeQueue()

    async def counting_receive(visibility_timeout: int, qty: int = 1) -> list[QueueMessage]:
        nonlocal receive_calls
        receive_calls += 1
        if receive_calls >= 3:
            shutdown.set()
        return []

    queue.receive = counting_receive  # type: ignore[method-assign]

    await asyncio.wait_for(
        consumer.run_forever_ingest(
            queue,
            "not-a-real-pool",  # type: ignore[arg-type]
            object(),  # type: ignore[arg-type]
            shutdown,
            poll_interval_seconds=0.01,
        ),
        timeout=2.0,
    )

    assert receive_calls == 3


async def test_both_loops_stop_promptly_on_a_shared_shutdown_event_run_concurrently() -> None:
    """The __main__.py shape: both loops in one TaskGroup on a shared
    shutdown Event. Asserts running them concurrently doesn't stop one from
    seeing shutdown promptly because the other is busy - each loop's own
    receive() sets shutdown after its own Nth call, and both must have
    actually stopped (not just one) within the wait_for budget.
    """
    shutdown = asyncio.Event()
    triage_calls = 0
    ingest_calls = 0

    triage_queue = FakeQueue()
    ingest_queue = FakeQueue()

    async def triage_receive(visibility_timeout: int, qty: int = 1) -> list[QueueMessage]:
        nonlocal triage_calls
        triage_calls += 1
        if triage_calls >= 5:
            shutdown.set()
        return []

    async def ingest_receive(visibility_timeout: int, qty: int = 1) -> list[QueueMessage]:
        nonlocal ingest_calls
        ingest_calls += 1
        return []

    triage_queue.receive = triage_receive  # type: ignore[method-assign]
    ingest_queue.receive = ingest_receive  # type: ignore[method-assign]

    async def run_both() -> None:
        async with asyncio.TaskGroup() as tg:
            tg.create_task(
                consumer.run_forever(
                    triage_queue,
                    "not-a-real-pool",  # type: ignore[arg-type]
                    shutdown,
                    poll_interval_seconds=0.01,
                )
            )
            tg.create_task(
                consumer.run_forever_ingest(
                    ingest_queue,
                    "not-a-real-pool",  # type: ignore[arg-type]
                    object(),  # type: ignore[arg-type]
                    shutdown,
                    poll_interval_seconds=0.01,
                )
            )

    await asyncio.wait_for(run_both(), timeout=2.0)

    assert triage_calls == 5
    # The ingest loop has no receive-count trigger of its own - it only
    # stops because it observes the *shared* shutdown Event, which is the
    # thing this test actually verifies.
    assert ingest_calls >= 1
