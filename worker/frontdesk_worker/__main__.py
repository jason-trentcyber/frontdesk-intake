"""Entrypoint: `python -m frontdesk_worker`. Wires settings -> pool -> queue ->
the consumer loop, and handles SIGTERM (every Kubernetes rolling update)
by letting the in-flight message finish before exiting.
"""

import asyncio
import logging
import signal

from .consumer import run_forever
from .db import create_pool
from .queue.create import create_queue
from .settings import load_settings

logging.basicConfig(level=logging.INFO, format='{"level": "%(levelname)s", "msg": %(message)r}')
logger = logging.getLogger(__name__)


async def main() -> None:
    settings = load_settings()
    pool = await create_pool(settings.database_url)
    queue = create_queue(settings, pool)

    shutdown = asyncio.Event()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, shutdown.set)

    logger.info("worker started")
    try:
        await run_forever(
            queue,
            pool,
            shutdown,
            visibility_timeout=settings.visibility_timeout_seconds,
            max_delivery_attempts=settings.max_delivery_attempts,
        )
    finally:
        logger.info("worker shutting down")
        await pool.close()


if __name__ == "__main__":
    asyncio.run(main())
