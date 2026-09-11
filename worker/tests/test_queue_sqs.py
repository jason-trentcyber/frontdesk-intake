import os
import uuid
from collections.abc import AsyncGenerator
from typing import Any

import boto3
import pytest

from frontdesk_worker.queue.sqs import SqsQueue

AWS_ENDPOINT_URL = os.environ.get("AWS_ENDPOINT_URL")
AWS_REGION = os.environ.get("AWS_REGION")

requires_localstack = pytest.mark.skipif(
    not AWS_ENDPOINT_URL or not AWS_REGION,
    reason="AWS_ENDPOINT_URL/AWS_REGION not set (LocalStack, ADR-0004)",
)


@pytest.fixture
def sqs_client() -> Any:
    assert AWS_ENDPOINT_URL and AWS_REGION
    return boto3.client("sqs", region_name=AWS_REGION, endpoint_url=AWS_ENDPOINT_URL)


@pytest.fixture
async def sqs_urls(sqs_client: Any) -> AsyncGenerator[tuple[str, str]]:
    name = f"frontdesk-triage-test-{uuid.uuid4().hex[:16]}"
    dlq_url = sqs_client.create_queue(QueueName=f"{name}-dlq")["QueueUrl"]
    queue_url = sqs_client.create_queue(QueueName=name)["QueueUrl"]
    try:
        yield queue_url, dlq_url
    finally:
        sqs_client.delete_queue(QueueUrl=queue_url)
        sqs_client.delete_queue(QueueUrl=dlq_url)


@pytest.fixture
def sqs_queue(sqs_urls: tuple[str, str]) -> SqsQueue:
    queue_url, dlq_url = sqs_urls
    assert AWS_REGION
    return SqsQueue(
        queue_url=queue_url, dlq_url=dlq_url, region=AWS_REGION, endpoint_url=AWS_ENDPOINT_URL
    )


@requires_localstack
async def test_send_and_receive_round_trip(sqs_queue: SqsQueue) -> None:
    msg_id = await sqs_queue.send({"orgId": "org-1", "requestId": "req-1"})
    assert isinstance(msg_id, str)

    [received] = await sqs_queue.receive(visibility_timeout=10)
    assert received.body == {"orgId": "org-1", "requestId": "req-1"}
    assert received.delivery_attempt == 1


@requires_localstack
async def test_ack_removes_the_message(sqs_queue: SqsQueue) -> None:
    await sqs_queue.send({"orgId": "org-1", "requestId": "req-1"})
    [received] = await sqs_queue.receive(visibility_timeout=10)

    await sqs_queue.ack(received.id)

    assert await sqs_queue.receive(visibility_timeout=0) == []


@requires_localstack
async def test_nack_makes_the_message_immediately_visible_again(sqs_queue: SqsQueue) -> None:
    await sqs_queue.send({"orgId": "org-1", "requestId": "req-1"})
    [received] = await sqs_queue.receive(visibility_timeout=30)

    await sqs_queue.nack(received.id)

    [redelivered] = await sqs_queue.receive(visibility_timeout=10)
    assert redelivered.body == received.body
    assert redelivered.delivery_attempt == 2


@requires_localstack
async def test_dead_letter_moves_the_message_to_the_dlq(
    sqs_queue: SqsQueue, sqs_client: Any, sqs_urls: tuple[str, str]
) -> None:
    _queue_url, dlq_url = sqs_urls
    await sqs_queue.send({"orgId": "org-1", "requestId": "req-1"})
    [received] = await sqs_queue.receive(visibility_timeout=10)

    await sqs_queue.dead_letter(received.id)

    assert await sqs_queue.receive(visibility_timeout=0) == []
    dlq_result = sqs_client.receive_message(QueueUrl=dlq_url, VisibilityTimeout=0)
    assert len(dlq_result.get("Messages", [])) == 1


@requires_localstack
async def test_dead_letter_without_a_cached_body_raises(sqs_queue: SqsQueue) -> None:
    with pytest.raises(RuntimeError, match="no cached body"):
        await sqs_queue.dead_letter("not-a-real-handle")
