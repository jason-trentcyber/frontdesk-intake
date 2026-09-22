"""Entrypoint: `python -m frontdesk_worker`. Wires settings -> pool -> the two
queues -> the two consumer loops (ADR-0023 §4, ADR-0025 §1 - one process,
one resident embedding model), and handles SIGTERM (every Kubernetes
rolling update) by letting each loop's in-flight message finish before
exiting.
"""

import asyncio
import logging
import signal

from .consumer import run_forever, run_forever_ingest
from .db import create_pool
from .ingestion.embedder import Embedder
from .logging_config import configure_logging
from .queue.create import create_ingest_queue, create_queue
from .settings import load_settings

# #29 stage 1 (ADR-0038 §2). The format string this replaced emitted
# `%(message)r` - Python repr, single-quoted - so ordinary log lines were not
# valid JSON, and it referenced none of the `extra=` fields consumer.py
# passes, so every org_id/request_id/msg_id was discarded. See
# logging_config.py's module docstring and tests/test_logging_config.py.
configure_logging(level=logging.INFO)
logger = logging.getLogger(__name__)


async def main() -> None:
    settings = load_settings()
    pool = await create_pool(settings.database_url)
    queue = create_queue(settings, pool)
    ingest_queue = create_ingest_queue(settings, pool)
    # Loaded once, here, not per message: the ~130 MB ONNX session and
    # tokenizer are shared by every message either loop handles - ingest's
    # chunk embeddings and (#25) triage's query embedding for retrieval -
    # ADR-0023 §4's "one process, one resident model".
    embedder = Embedder()

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, shutdown.set)

    logger.info("worker started")
    try:
        # TaskGroup, not asyncio.gather: if either loop raises (e.g.
        # receive() on a queue that doesn't exist yet, ADR-0022), the group
        # cancels the other loop and re-raises, so the process still exits
        # non-zero and crash-loops rather than leaving one loop running
        # orphaned while the other has already failed.
        async with asyncio.TaskGroup() as tg:
            tg.create_task(
                run_forever(
                    queue,
                    pool,
                    embedder,
                    settings,
                    shutdown,
                    visibility_timeout=settings.visibility_timeout_seconds,
                    max_delivery_attempts=settings.max_delivery_attempts,
                ),
                name="triage-consumer",
            )
            tg.create_task(
                run_forever_ingest(
                    ingest_queue,
                    pool,
                    embedder,
                    shutdown,
                    visibility_timeout=settings.visibility_timeout_seconds,
                    max_delivery_attempts=settings.max_delivery_attempts,
                ),
                name="ingest-consumer",
            )
    finally:
        logger.info("worker shutting down")
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
