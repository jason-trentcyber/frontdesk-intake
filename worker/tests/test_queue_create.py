import pytest

from frontdesk_worker.queue.create import create_ingest_queue, create_queue
from frontdesk_worker.queue.pgmq import PgmqQueue
from frontdesk_worker.queue.sqs import SqsQueue
from frontdesk_worker.settings import Settings


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


def test_pgmq_provider_returns_a_pgmq_queue() -> None:
    # create_queue() only stores the pool (no I/O at construction time), so
    # a plain sentinel stands in for a real asyncpg.Pool here.
    queue = create_queue(_settings(queue_provider="pgmq"), pool="not-a-real-pool")  # type: ignore[arg-type]

    assert isinstance(queue, PgmqQueue)


def test_sqs_provider_with_all_settings_returns_an_sqs_queue() -> None:
    queue = create_queue(
        _settings(
            queue_provider="sqs",
            aws_region="us-east-1",
            sqs_queue_url="https://sqs.example/queue",
            sqs_dlq_url="https://sqs.example/dlq",
        ),
        pool="not-a-real-pool",  # type: ignore[arg-type]
    )

    assert isinstance(queue, SqsQueue)


@pytest.mark.parametrize(
    "missing_field",
    ["sqs_queue_url", "sqs_dlq_url", "aws_region"],
)
def test_sqs_provider_missing_any_setting_raises(missing_field: str) -> None:
    complete: dict[str, str | None] = {
        "aws_region": "us-east-1",
        "sqs_queue_url": "https://sqs.example/queue",
        "sqs_dlq_url": "https://sqs.example/dlq",
    }
    complete[missing_field] = None

    with pytest.raises(ValueError, match="SQS_QUEUE_URL, SQS_DLQ_URL, and AWS_REGION"):
        create_queue(
            _settings(queue_provider="sqs", **complete),
            pool="not-a-real-pool",  # type: ignore[arg-type]
        )


def test_unknown_provider_raises() -> None:
    with pytest.raises(ValueError, match="Unknown QUEUE_PROVIDER"):
        create_queue(_settings(queue_provider="kafka"), pool="not-a-real-pool")  # type: ignore[arg-type]


# Same branches, the ingest queue (ADR-0025 §1) - its own name under pgmq,
# its own URL pair under sqs.
def test_ingest_pgmq_provider_returns_a_pgmq_queue() -> None:
    queue = create_ingest_queue(_settings(queue_provider="pgmq"), pool="not-a-real-pool")  # type: ignore[arg-type]

    assert isinstance(queue, PgmqQueue)


def test_ingest_sqs_provider_with_all_settings_returns_an_sqs_queue() -> None:
    queue = create_ingest_queue(
        _settings(
            queue_provider="sqs",
            aws_region="us-east-1",
            ingest_sqs_queue_url="https://sqs.example/ingest",
            ingest_sqs_dlq_url="https://sqs.example/ingest-dlq",
        ),
        pool="not-a-real-pool",  # type: ignore[arg-type]
    )

    assert isinstance(queue, SqsQueue)


@pytest.mark.parametrize(
    "missing_field",
    ["ingest_sqs_queue_url", "ingest_sqs_dlq_url", "aws_region"],
)
def test_ingest_sqs_provider_missing_any_setting_raises(missing_field: str) -> None:
    complete: dict[str, str | None] = {
        "aws_region": "us-east-1",
        "ingest_sqs_queue_url": "https://sqs.example/ingest",
        "ingest_sqs_dlq_url": "https://sqs.example/ingest-dlq",
    }
    complete[missing_field] = None

    with pytest.raises(ValueError, match="SQS_QUEUE_URL, SQS_DLQ_URL, and AWS_REGION"):
        create_ingest_queue(
            _settings(queue_provider="sqs", **complete),
            pool="not-a-real-pool",  # type: ignore[arg-type]
        )


def test_ingest_unknown_provider_raises() -> None:
    with pytest.raises(ValueError, match="Unknown QUEUE_PROVIDER"):
        create_ingest_queue(_settings(queue_provider="kafka"), pool="not-a-real-pool")  # type: ignore[arg-type]
