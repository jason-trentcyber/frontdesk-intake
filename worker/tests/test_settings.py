import pytest

from frontdesk_worker.settings import InvalidSettings, load_settings

_BASE_ENV = {
    "DATABASE_URL": "postgresql://frontdesk:frontdesk@localhost:5432/frontdesk",
    "QUEUE_PROVIDER": "pgmq",
    "LLM_PROVIDER": "fake",
}


def test_prefers_database_app_url_over_database_url() -> None:
    settings = load_settings(
        {
            **_BASE_ENV,
            "DATABASE_APP_URL": "postgresql://frontdesk_app:frontdesk_app@localhost:5432/frontdesk",
        }
    )

    assert (
        settings.database_url == "postgresql://frontdesk_app:frontdesk_app@localhost:5432/frontdesk"
    )


def test_falls_back_to_database_url_when_app_url_is_absent() -> None:
    settings = load_settings(_BASE_ENV)

    assert settings.database_url == _BASE_ENV["DATABASE_URL"]


def test_missing_both_database_urls_raises() -> None:
    env = {k: v for k, v in _BASE_ENV.items() if k != "DATABASE_URL"}

    with pytest.raises(InvalidSettings, match="DATABASE_URL"):
        load_settings(env)


def test_invalid_queue_provider_raises() -> None:
    env = {**_BASE_ENV, "QUEUE_PROVIDER": "kafka"}

    with pytest.raises(InvalidSettings, match="QUEUE_PROVIDER"):
        load_settings(env)


def test_invalid_llm_provider_raises() -> None:
    env = {**_BASE_ENV, "LLM_PROVIDER": "chatgpt"}

    with pytest.raises(InvalidSettings, match="LLM_PROVIDER"):
        load_settings(env)


@pytest.mark.parametrize(
    "missing_key",
    ["AWS_REGION", "SQS_QUEUE_URL", "SQS_DLQ_URL", "INGEST_SQS_QUEUE_URL", "INGEST_SQS_DLQ_URL"],
)
def test_sqs_provider_requires_each_aws_setting(missing_key: str) -> None:
    env = {
        **_BASE_ENV,
        "QUEUE_PROVIDER": "sqs",
        "AWS_REGION": "us-east-1",
        "SQS_QUEUE_URL": "https://sqs.example/queue",
        "SQS_DLQ_URL": "https://sqs.example/dlq",
        "INGEST_SQS_QUEUE_URL": "https://sqs.example/ingest",
        "INGEST_SQS_DLQ_URL": "https://sqs.example/ingest-dlq",
    }
    del env[missing_key]

    with pytest.raises(InvalidSettings, match=missing_key):
        load_settings(env)


def test_sqs_provider_with_all_settings_present_succeeds() -> None:
    env = {
        **_BASE_ENV,
        "QUEUE_PROVIDER": "sqs",
        "AWS_REGION": "us-east-1",
        "SQS_QUEUE_URL": "https://sqs.example/queue",
        "SQS_DLQ_URL": "https://sqs.example/dlq",
        "INGEST_SQS_QUEUE_URL": "https://sqs.example/ingest",
        "INGEST_SQS_DLQ_URL": "https://sqs.example/ingest-dlq",
    }

    settings = load_settings(env)

    assert settings.queue_provider == "sqs"
    assert settings.aws_region == "us-east-1"
    assert settings.sqs_queue_url == "https://sqs.example/queue"
    assert settings.sqs_dlq_url == "https://sqs.example/dlq"
    assert settings.ingest_sqs_queue_url == "https://sqs.example/ingest"
    assert settings.ingest_sqs_dlq_url == "https://sqs.example/ingest-dlq"


def test_defaults() -> None:
    settings = load_settings(_BASE_ENV)

    assert settings.llm_model == "haiku"
    assert settings.visibility_timeout_seconds == 15
    assert settings.max_delivery_attempts == 5
    # Matches deploy/chart/values.yaml's worker.globalDailySpendCeilingUsd
    # (#100) - see settings.py's comment for why the two must agree.
    assert settings.global_daily_spend_ceiling_usd == 1.00
    assert settings.aws_region is None
    assert settings.sqs_queue_url is None
    assert settings.sqs_dlq_url is None
    assert settings.ingest_sqs_queue_url is None
    assert settings.ingest_sqs_dlq_url is None
