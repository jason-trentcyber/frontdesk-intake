"""SQS adapter (ADR-0004). Mirrors api/src/queue/sqs.ts's SqsQueue, including
its documented impedance mismatch: SQS's ack/nack/dead_letter take a receipt
handle, not a stable message id, and dead_letter needs the body too (to copy
it to the DLQ - LocalStack does not enforce a redrive policy for us). Cached
per-instance, keyed by the same id handed back from receive(), evicted on
ack()/dead_letter().

Uses boto3 (sync), off-loaded to a thread via asyncio.to_thread to keep the
Queue protocol async without pulling in aioboto3 for one adapter that is
switch-proven, not live in production (QUEUE_PROVIDER=pgmq).

This file necessarily imports boto3 even though ADR-0006's grep test bans
that string outside worker/llm/ - see tests/test_provider_isolation.py for
why that's the right scope for what the grep test protects (leaking an LLM
*provider* name), not a blanket ban on the AWS SDK, which ADR-0004 already
requires here for a service ADR-0006 has nothing to do with.
"""

import asyncio
import json

import boto3

from . import QueueMessage


class SqsQueue:
    def __init__(
        self,
        queue_url: str,
        dlq_url: str,
        region: str,
        endpoint_url: str | None = None,
    ) -> None:
        self._client = boto3.client("sqs", region_name=region, endpoint_url=endpoint_url)
        self._queue_url = queue_url
        self._dlq_url = dlq_url
        self._received: dict[str, object] = {}

    async def send(self, payload: object) -> str:
        result = await asyncio.to_thread(
            self._client.send_message, QueueUrl=self._queue_url, MessageBody=json.dumps(payload)
        )
        message_id = result.get("MessageId")
        if not message_id:
            raise RuntimeError("send_message returned no MessageId")
        return message_id

    async def receive(self, visibility_timeout: int, qty: int = 1) -> list[QueueMessage]:
        result = await asyncio.to_thread(
            self._client.receive_message,
            QueueUrl=self._queue_url,
            VisibilityTimeout=visibility_timeout,
            MaxNumberOfMessages=min(qty, 10),  # hard SQS API ceiling
            AttributeNames=["ApproximateReceiveCount"],
        )
        messages = result.get("Messages", [])
        out: list[QueueMessage] = []
        for m in messages:
            handle = m.get("ReceiptHandle")
            body_raw = m.get("Body")
            if not handle or body_raw is None:
                raise RuntimeError("SQS message missing ReceiptHandle or Body")
            body = json.loads(body_raw)
            self._received[handle] = body
            attempt = int(m.get("Attributes", {}).get("ApproximateReceiveCount", 1))
            out.append(QueueMessage(id=handle, body=body, delivery_attempt=attempt))
        return out

    async def ack(self, msg_id: str) -> None:
        await asyncio.to_thread(
            self._client.delete_message, QueueUrl=self._queue_url, ReceiptHandle=msg_id
        )
        self._received.pop(msg_id, None)

    # See sqs.ts's nack() for the same caveat: the receipt handle is not
    # reliably reusable after this call without an intervening receive().
    async def nack(self, msg_id: str) -> None:
        await asyncio.to_thread(
            self._client.change_message_visibility,
            QueueUrl=self._queue_url,
            ReceiptHandle=msg_id,
            VisibilityTimeout=0,
        )

    async def dead_letter(self, msg_id: str) -> None:
        body = self._received.get(msg_id)
        if body is None:
            raise RuntimeError(
                f"dead_letter({msg_id}): no cached body - id must come from receive() on this adapter instance"
            )
        await asyncio.to_thread(
            self._client.send_message, QueueUrl=self._dlq_url, MessageBody=json.dumps(body)
        )
        await asyncio.to_thread(
            self._client.delete_message, QueueUrl=self._queue_url, ReceiptHandle=msg_id
        )
        self._received.pop(msg_id, None)
