"""The triage pipeline seam (#23 scope boundary).

#23 is the consumer loop and the LLM provider layer - NOT the triage
pipeline itself (classify/route/retrieve/draft, #25) and NOT ingestion
(chunk/embed/index, #24). run_triage_pipeline is a deliberate stub: the
consumer loop (consumer.py) calls it after opening the tenant-scoped
transaction and setting requests.status = 'triaging', and #25 replaces this
body with the real classify -> route -> retrieve -> draft flow, using
frontdesk_worker.spend.resolve_provider() for its LLM calls.

Do not grow this into a partial triage implementation - tests/test_consumer.py
asserts only that the loop calls this function, not what it does.
"""

import asyncpg

from .queue import Queue


async def run_triage_pipeline(
    conn: asyncpg.pool.PoolConnectionProxy, queue: Queue, org_id: str, request_id: str
) -> None:
    """#25 fills this in: classify, route, retrieve, draft. Left unimplemented
    on purpose - see this module's docstring.
    """
    raise NotImplementedError("the triage pipeline itself is #25's scope, not #23's")
