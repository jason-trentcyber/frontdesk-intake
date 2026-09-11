"""Selection by QUEUE_PROVIDER only - no auto-detection, no other switch
(ADR-0004). Mirrors api/src/queue/create.ts.
"""

import asyncpg

from ..settings import Settings
from . import Queue
from .pgmq import PgmqQueue
from .sqs import SqsQueue


def create_queue(settings: Settings, pool: asyncpg.Pool) -> Queue:
    if settings.queue_provider == "pgmq":
        return PgmqQueue(pool)
    if settings.queue_provider == "sqs":
        if not settings.sqs_queue_url or not settings.sqs_dlq_url or not settings.aws_region:
            raise ValueError(
                "SQS_QUEUE_URL, SQS_DLQ_URL, and AWS_REGION are required when QUEUE_PROVIDER=sqs"
            )
        return SqsQueue(
            queue_url=settings.sqs_queue_url,
            dlq_url=settings.sqs_dlq_url,
            region=settings.aws_region,
            endpoint_url=settings.aws_endpoint_url,
        )
    raise ValueError(f"Unknown QUEUE_PROVIDER: {settings.queue_provider}")
