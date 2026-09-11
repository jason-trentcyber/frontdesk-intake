"""Env-only configuration, mirroring api/src/env.ts's loadEnv().

All config by environment variables (docs/conventions.md → Configuration).
Provider selection is env-only: QUEUE_PROVIDER, LLM_PROVIDER - no code
outside the respective adapter packages may branch on these. This file
validates LLM_PROVIDER's value without spelling out any provider's name
itself - it imports llm.KNOWN_PROVIDERS instead of writing the literal
names, so ADR-0006's grep test (tests/test_provider_isolation.py) still
finds exactly one place those names live, in worker/llm/ itself, comments
included. For the same reason, this file never reads a provider-specific
API key env var - llm.get_provider() reads that directly.
"""

import os
from dataclasses import dataclass

from llm import KNOWN_PROVIDERS


class InvalidSettings(Exception):
    pass


@dataclass(frozen=True)
class Settings:
    database_url: str
    queue_provider: str  # "pgmq" | "sqs"
    llm_provider: str  # one of llm.KNOWN_PROVIDERS
    llm_model: str
    # ADR-0023 §4: the worker's own visibility timeout / retry ceiling for
    # the consumer loop - see frontdesk_worker/consumer.py for the values
    # chosen and why.
    visibility_timeout_seconds: int
    max_delivery_attempts: int
    # ADR-0023 §5 layer 3: global daily spend ceiling in USD, above which
    # the worker switches itself to the fake provider for the rest of the
    # UTC day. Distinct from the vendor cap on the live provider's own key
    # (layer 1, nothing to build) - this is a worker-enforced backstop that
    # degrades gracefully instead of the key simply starting to 402.
    global_daily_spend_ceiling_usd: float
    aws_region: str | None
    aws_endpoint_url: str | None
    sqs_queue_url: str | None
    sqs_dlq_url: str | None


def load_settings(source: dict[str, str] | None = None) -> Settings:
    env = source if source is not None else os.environ

    # Same DATABASE_APP_URL-preferred-over-DATABASE_URL fallback as
    # api/src/env.ts: locally DATABASE_URL is the owner role and
    # DATABASE_APP_URL is frontdesk_app; in the cluster only the app-role
    # DATABASE_URL is ever set (ADR-0017/0021), so preferring
    # DATABASE_APP_URL resolves correctly in both places.
    database_url = env.get("DATABASE_APP_URL") or env.get("DATABASE_URL")
    if not database_url:
        raise InvalidSettings("DATABASE_URL (or DATABASE_APP_URL locally) is required")

    queue_provider = env.get("QUEUE_PROVIDER")
    if queue_provider not in ("pgmq", "sqs"):
        raise InvalidSettings(f"QUEUE_PROVIDER must be 'pgmq' or 'sqs', got {queue_provider!r}")

    llm_provider = env.get("LLM_PROVIDER")
    if llm_provider not in KNOWN_PROVIDERS:
        raise InvalidSettings(
            f"LLM_PROVIDER must be one of {sorted(KNOWN_PROVIDERS)}, got {llm_provider!r}"
        )

    if queue_provider == "sqs":
        for key in ("AWS_REGION", "SQS_QUEUE_URL", "SQS_DLQ_URL"):
            if not env.get(key):
                raise InvalidSettings(f"{key} is required when QUEUE_PROVIDER=sqs")

    return Settings(
        database_url=database_url,
        queue_provider=queue_provider,
        llm_provider=llm_provider,
        llm_model=env.get("LLM_MODEL", "haiku"),
        # 15s, matching consumer.py's DEFAULT_VISIBILITY_TIMEOUT_SECONDS and
        # the chart's worker.visibilityTimeoutSeconds - see consumer.py's
        # header docstring for why 15s was chosen over pgmq/SQS's usual
        # default. All three must agree; this is the one env fallback of
        # the three that isn't sourced from consumer.py's constant directly
        # because __main__.py always passes settings.visibility_timeout_seconds
        # through explicitly rather than relying on run_forever()'s default.
        visibility_timeout_seconds=int(env.get("VISIBILITY_TIMEOUT_SECONDS", "15")),
        max_delivery_attempts=int(env.get("MAX_DELIVERY_ATTEMPTS", "5")),
        global_daily_spend_ceiling_usd=float(env.get("GLOBAL_DAILY_SPEND_CEILING_USD", "0.30")),
        aws_region=env.get("AWS_REGION") or None,
        aws_endpoint_url=env.get("AWS_ENDPOINT_URL") or None,
        sqs_queue_url=env.get("SQS_QUEUE_URL") or None,
        sqs_dlq_url=env.get("SQS_DLQ_URL") or None,
    )
