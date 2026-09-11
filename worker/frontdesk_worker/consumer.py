"""The consumer loop (#23 §3): receive -> validate -> for_org -> pipeline seam
-> ack/nack/dead_letter.

Judgment calls (see the PR body for the full reasoning):

- visibility_timeout defaults to 15s. F9 targets a draft visible within 10s
  at p95; a 60s timeout would leave a crashed worker's request invisible to
  every other consideration for a full minute. 15s gives the (single, per
  ADR-0023 §4) worker room to validate, open the tenant transaction, and
  hand off to the pipeline before pgmq/SQS redeliver out from under it, while
  still keeping a crash's worst case well under F9's budget. #25's real LLM
  call is the one thing that could plausibly run long against this number -
  if it does in practice, that's this worker's own visibility_timeout to
  raise via VISIBILITY_TIMEOUT_SECONDS, not a reason to default it high now.
- max_delivery_attempts defaults to 5. Low enough that a poison message
  doesn't sit re-processing for many minutes at 15s a turn (5 attempts is
  75s of wall-clock worst case), high enough to absorb a transient blip
  (a Postgres failover, an LLM 5xx) without dead-lettering something that
  would have succeeded on a second try.
- poll_interval_seconds (no message received) defaults to 2s: frequent
  enough to stay inside F9's budget from the moment a message is enqueued,
  cheap enough not to matter at this traffic volume (ADR-0023's cost table).
"""

import asyncio
import logging

import asyncpg

from .contracts import InvalidTriageMessage, validate_triage_message
from .db import for_org
from .pipeline import run_triage_pipeline
from .queue import Queue

logger = logging.getLogger(__name__)

DEFAULT_VISIBILITY_TIMEOUT_SECONDS = 15
DEFAULT_MAX_DELIVERY_ATTEMPTS = 5
DEFAULT_POLL_INTERVAL_SECONDS = 2.0


async def process_one(
    queue: Queue,
    pool: asyncpg.Pool,
    *,
    visibility_timeout: int,
    max_delivery_attempts: int,
) -> bool:
    """Receives and handles a single message. Returns True if a message was
    received (regardless of outcome), False if the queue was empty.

    receive() itself is not caught here: if the queue does not exist (ADR-0022 -
    the worker never creates it, api/ does at startup), that error must
    propagate and crash the process rather than be swallowed as "no
    messages" - a crash-looping pod is the correct signal that api/ has not
    started yet.
    """
    messages = await queue.receive(visibility_timeout, qty=1)
    if not messages:
        return False

    message = messages[0]
    try:
        body = validate_triage_message(message.body)
    except InvalidTriageMessage as exc:
        # Never log message.body: an unvalidated body may contain another
        # org's data (the queue has no RLS to have caught that already).
        logger.error(
            "message failed contract validation - dead-lettering, not retrying",
            extra={"msg_id": message.id, "error": str(exc)},
        )
        await queue.dead_letter(message.id)
        return True

    org_id = str(body["orgId"])
    request_id = str(body["requestId"])

    try:
        async with for_org(pool, org_id) as conn:
            await conn.execute(
                "update requests set status = 'triaging' where org_id = $1 and id = $2",
                org_id,
                request_id,
            )
            await run_triage_pipeline(conn, queue, org_id, request_id)
    except Exception:
        if message.delivery_attempt >= max_delivery_attempts:
            logger.exception(
                "message exceeded the retry ceiling - dead-lettering",
                extra={
                    "msg_id": message.id,
                    "org_id": org_id,
                    "request_id": request_id,
                    "delivery_attempt": message.delivery_attempt,
                },
            )
            await queue.dead_letter(message.id)
        else:
            logger.exception(
                "message processing failed - nacking for redelivery",
                extra={
                    "msg_id": message.id,
                    "org_id": org_id,
                    "request_id": request_id,
                    "delivery_attempt": message.delivery_attempt,
                },
            )
            await queue.nack(message.id)
        return True

    await queue.ack(message.id)
    return True


async def run_forever(
    queue: Queue,
    pool: asyncpg.Pool,
    shutdown: asyncio.Event,
    *,
    visibility_timeout: int = DEFAULT_VISIBILITY_TIMEOUT_SECONDS,
    max_delivery_attempts: int = DEFAULT_MAX_DELIVERY_ATTEMPTS,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
) -> None:
    """Polls until `shutdown` is set. Checks `shutdown` only between messages,
    never mid-message: SIGTERM (every Kubernetes rolling update) must finish
    the in-flight message before exiting, not abandon it half-processed.
    """
    while not shutdown.is_set():
        got_message = await process_one(
            queue,
            pool,
            visibility_timeout=visibility_timeout,
            max_delivery_attempts=max_delivery_attempts,
        )
        if not got_message:
            try:
                await asyncio.wait_for(shutdown.wait(), timeout=poll_interval_seconds)
            except TimeoutError:
                pass
