"""Selection by QUEUE_PROVIDER only - no auto-detection, no other switch
(ADR-0004). Mirrors api/src/queue/create.ts, including its
createQueue/createIngestQueue split (ADR-0025 §1) around one shared
provider-branching helper.
"""

import asyncpg

from ..settings import Settings
from . import INGEST_QUEUE_NAME, QUEUE_NAME, Queue
from .pgmq import PgmqQueue
from .sqs import SqsQueue


def _create_queue_for(
    settings: Settings,
    pool: asyncpg.Pool,
    *,
    pgmq_name: str,
    sqs_queue_url: str | None,
    sqs_dlq_url: str | None,
) -> Queue:
    if settings.queue_provider == "pgmq":
        return PgmqQueue(pool, queue_name=pgmq_name)
    if settings.queue_provider == "sqs":
        if not sqs_queue_url or not sqs_dlq_url or not settings.aws_region:
            raise ValueError(
                "SQS_QUEUE_URL, SQS_DLQ_URL, and AWS_REGION are required when QUEUE_PROVIDER=sqs"
            )
        return SqsQueue(
            queue_url=sqs_queue_url,
            dlq_url=sqs_dlq_url,
            region=settings.aws_region,
            endpoint_url=settings.aws_endpoint_url,
        )
    raise ValueError(f"Unknown QUEUE_PROVIDER: {settings.queue_provider}")


def create_queue(settings: Settings, pool: asyncpg.Pool) -> Queue:
    return _create_queue_for(
        settings,
        pool,
        pgmq_name=QUEUE_NAME,
        sqs_queue_url=settings.sqs_queue_url,
        sqs_dlq_url=settings.sqs_dlq_url,
    )


def create_ingest_queue(settings: Settings, pool: asyncpg.Pool) -> Queue:
    return _create_queue_for(
        settings,
        pool,
        pgmq_name=INGEST_QUEUE_NAME,
        sqs_queue_url=settings.ingest_sqs_queue_url,
        sqs_dlq_url=settings.ingest_sqs_dlq_url,
    )
