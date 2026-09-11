"""The consumer side of ADR-0004: five operations, pgmq + sqs adapters.

Mirrors api/src/queue/index.ts. Selection by QUEUE_PROVIDER env only - no
auto-detection, no other switch. The worker does NOT create the queue
(ADR-0022): api/ creates it at startup as frontdesk_app. If the queue is
missing, receive() raises and the worker's readiness check must fail - that
means api/ has not started yet, not a worker bug.
"""

from dataclasses import dataclass
from typing import Protocol, TypeVar

T = TypeVar("T")

QUEUE_NAME = "frontdesk_triage"

# ADR-0025 §1: the ingestion trigger queue, mirroring
# api/src/queue/index.ts's INGEST_QUEUE_NAME exactly.
INGEST_QUEUE_NAME = "frontdesk_ingest"


@dataclass(frozen=True)
class QueueMessage:
    """Opaque handle (id) to ack/nack/dead_letter this specific receive, plus
    the raw, not-yet-validated body - not a stable message identity (SQS's is
    a receipt handle; pgmq's is the row's msg_id, which happens to be stable,
    but treat both the same way). Same shape as TS's QueueMessage<T>, except
    body is left as `object` here: the contract validator (contracts.py) is
    what gives it a type, deliberately after receive() rather than as part
    of it, so an invalid body can still be logged by id and dead-lettered.

    delivery_attempt is this receive's 1-indexed count - pgmq's read_ct,
    SQS's ApproximateReceiveCount - so the consumer loop (consumer.py) can
    enforce the retry ceiling without keeping its own state; a crashed and
    restarted worker still sees the true count on redelivery.
    """

    id: str
    body: object
    delivery_attempt: int


class Queue(Protocol):
    async def send(self, payload: object) -> str: ...
    async def receive(self, visibility_timeout: int, qty: int = 1) -> list[QueueMessage]: ...
    async def ack(self, msg_id: str) -> None: ...
    async def nack(self, msg_id: str) -> None: ...
    async def dead_letter(self, msg_id: str) -> None: ...
