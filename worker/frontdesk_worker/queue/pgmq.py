"""Postgres pgmq adapter (ADR-0004). Signatures verified in api/src/queue/pgmq.ts
against the pinned image (ghcr.io/jason-trentcyber/frontdesk-postgres) -
reused here rather than rediscovered:

  pgmq.send(queue_name text, msg jsonb) -> SETOF bigint
  pgmq.read(queue_name text, vt integer, qty integer, conditional jsonb DEFAULT '{}') -> SETOF pgmq.message_record
  pgmq.delete(queue_name text, msg_id bigint) -> boolean         (ack)
  pgmq.set_vt(queue_name text, msg_id bigint, vt integer) -> SETOF message_record   (set_vt(..., 0) is nack)
  pgmq.archive(queue_name text, msg_id bigint) -> boolean        (dead-letter primitive; there is no pgmq.dead_letter)

message_record: (msg_id bigint, read_ct integer, enqueued_at timestamptz,
  last_read_at timestamptz, vt timestamptz, message jsonb, headers jsonb).
"""

import json

import asyncpg

from . import QUEUE_NAME, QueueMessage


class PgmqQueue:
    def __init__(self, pool: asyncpg.Pool, queue_name: str = QUEUE_NAME) -> None:
        self._pool = pool
        self._queue_name = queue_name

    async def send(self, payload: object) -> str:
        row = await self._pool.fetchrow(
            "select * from pgmq.send($1, $2::jsonb)", self._queue_name, json.dumps(payload)
        )
        if row is None:
            raise RuntimeError(f"pgmq.send('{self._queue_name}') returned no rows")
        return str(row["send"])

    async def receive(self, visibility_timeout: int, qty: int = 1) -> list[QueueMessage]:
        rows = await self._pool.fetch(
            "select msg_id, read_ct, message from pgmq.read($1, $2, $3)",
            self._queue_name,
            visibility_timeout,
            qty,
        )
        return [
            QueueMessage(
                id=str(row["msg_id"]),
                body=json.loads(row["message"]),
                delivery_attempt=int(row["read_ct"]),
            )
            for row in rows
        ]

    async def ack(self, msg_id: str) -> None:
        await self._pool.execute(
            "select pgmq.delete($1, $2::bigint)", self._queue_name, int(msg_id)
        )

    async def nack(self, msg_id: str) -> None:
        await self._pool.execute(
            "select pgmq.set_vt($1, $2::bigint, 0)", self._queue_name, int(msg_id)
        )

    # archive() moves the row from q_<queue> to a_<queue> server-side - the
    # closest primitive to a dead-letter, needing only the id (unlike
    # SqsQueue.dead_letter, which needs the cached body too).
    async def dead_letter(self, msg_id: str) -> None:
        await self._pool.execute(
            "select pgmq.archive($1, $2::bigint)", self._queue_name, int(msg_id)
        )
