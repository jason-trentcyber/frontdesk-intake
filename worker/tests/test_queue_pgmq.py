import uuid
from collections.abc import AsyncGenerator

import asyncpg
import pytest
from conftest import requires_postgres

from frontdesk_worker.queue.pgmq import PgmqQueue


@pytest.fixture
async def pgmq_queue(app_pool: asyncpg.Pool) -> AsyncGenerator[PgmqQueue]:
    # A uniquely-named queue per test, not QUEUE_NAME: the worker never
    # creates the production queue (ADR-0022 - api/ does, at startup), so
    # test setup creates its own scratch queue instead of relying on or
    # colliding with that one.
    name = f"test_{uuid.uuid4().hex[:16]}"
    await app_pool.execute("select pgmq.create($1)", name)
    try:
        yield PgmqQueue(app_pool, queue_name=name)
    finally:
        await app_pool.execute("select pgmq.drop_queue($1)", name)


@requires_postgres
async def test_send_and_receive_round_trip(pgmq_queue: PgmqQueue) -> None:
    msg_id = await pgmq_queue.send({"orgId": "org-1", "requestId": "req-1"})
    assert isinstance(msg_id, str)

    received = await pgmq_queue.receive(visibility_timeout=10)
    assert len(received) == 1
    assert received[0].id == msg_id
    assert received[0].body == {"orgId": "org-1", "requestId": "req-1"}
    assert received[0].delivery_attempt == 1


@requires_postgres
async def test_ack_removes_the_message(pgmq_queue: PgmqQueue) -> None:
    await pgmq_queue.send({"orgId": "org-1", "requestId": "req-1"})
    [received] = await pgmq_queue.receive(visibility_timeout=10)

    await pgmq_queue.ack(received.id)

    assert await pgmq_queue.receive(visibility_timeout=0) == []


@requires_postgres
async def test_nack_makes_the_message_immediately_visible_again(pgmq_queue: PgmqQueue) -> None:
    await pgmq_queue.send({"orgId": "org-1", "requestId": "req-1"})
    [received] = await pgmq_queue.receive(visibility_timeout=30)

    await pgmq_queue.nack(received.id)

    [redelivered] = await pgmq_queue.receive(visibility_timeout=10)
    assert redelivered.id == received.id
    assert redelivered.delivery_attempt == 2


@requires_postgres
async def test_dead_letter_archives_the_message(pgmq_queue: PgmqQueue) -> None:
    await pgmq_queue.send({"orgId": "org-1", "requestId": "req-1"})
    [received] = await pgmq_queue.receive(visibility_timeout=10)

    await pgmq_queue.dead_letter(received.id)

    assert await pgmq_queue.receive(visibility_timeout=0) == []
