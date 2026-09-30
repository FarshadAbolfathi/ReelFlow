"""Redis Streams consumer with explicit retry/backoff.

- XREADGROUP delivers each message to one consumer.
- A message is XACKed only after its handler finished (success or final failure).
- Retryable failures are re-scheduled in a sorted set with exponential backoff
  and re-added to the stream when due (attempt counter carried along).
- Messages left pending by a crashed consumer are reclaimed with XAUTOCLAIM.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
from collections.abc import Awaitable, Callable
from typing import Any

import structlog
from redis.asyncio import Redis
from redis.exceptions import ResponseError

from .pipeline import RetryableError
from .queues import CONSUMER_GROUP, STREAMS

log = structlog.get_logger("streams")

Handler = Callable[[dict[str, Any], str, int], Awaitable[dict[str, Any]]]


def backoff_seconds(attempt: int, base: float = 30.0, cap: float = 3600.0) -> float:
    exp = min(cap, base * 2 ** max(0, attempt - 1))
    return exp / 2 + random.random() * exp / 2


async def ensure_group(redis: Redis, stream: str, group: str = CONSUMER_GROUP) -> None:
    try:
        await redis.xgroup_create(stream, group, id="0", mkstream=True)
    except ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


class StreamConsumer:
    def __init__(self, redis: Redis, queue: str, handler: Handler, consumer: str, *, max_attempts: int = 5, concurrency: int = 2) -> None:
        self.redis = redis
        self.queue = queue
        self.stream = STREAMS[queue]
        self.handler = handler
        self.consumer = consumer
        self.max_attempts = max_attempts
        self._sem = asyncio.Semaphore(concurrency)
        self._stopping = asyncio.Event()
        self._tasks: set[asyncio.Task[None]] = set()

    def stop(self) -> None:
        self._stopping.set()

    async def run(self) -> None:
        await ensure_group(self.redis, self.stream)
        await self._reclaim()
        last_reclaim = time.monotonic()
        while not self._stopping.is_set():
            try:
                resp = await self.redis.xreadgroup(CONSUMER_GROUP, self.consumer, {self.stream: ">"}, count=5, block=3000)
            except (ConnectionError, OSError) as e:
                log.error("stream_read_failed", queue=self.queue, error=str(e))
                await asyncio.sleep(2)
                continue
            for _stream, messages in resp or []:
                for msg_id, fields in messages:
                    await self._sem.acquire()
                    t = asyncio.create_task(self._handle(msg_id, fields))
                    self._tasks.add(t)
                    t.add_done_callback(self._tasks.discard)
            if time.monotonic() - last_reclaim > 300:
                await self._reclaim()
                last_reclaim = time.monotonic()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    async def _reclaim(self) -> None:
        try:
            _next, claimed, *_ = await self.redis.xautoclaim(self.stream, CONSUMER_GROUP, self.consumer, min_idle_time=10 * 60_000, count=50)
        except ResponseError:
            return
        for msg_id, fields in claimed:
            await self._sem.acquire()
            await self._handle(msg_id, fields)

    async def _handle(self, msg_id: bytes | str, fields: dict[bytes | str, bytes | str]) -> None:
        try:
            f = {(k.decode() if isinstance(k, bytes) else k): (v.decode() if isinstance(v, bytes) else v) for k, v in fields.items()}
            job_id = f.get("jobId", str(msg_id))
            attempt = int(f.get("attempt", "1"))
            data = json.loads(f.get("data", "{}"))
            try:
                result = await self.handler(data, job_id, attempt)
                log.info("job_done", queue=self.queue, job_id=job_id, attempt=attempt, result=result)
            except RetryableError as e:
                if attempt < self.max_attempts:
                    delay = backoff_seconds(attempt)
                    payload = json.dumps({"queue": self.queue, "jobId": job_id, "data": data, "attempt": attempt + 1})
                    await self.redis.zadd(STREAMS["retry"], {payload: time.time() + delay})
                    log.warning("job_retry_scheduled", queue=self.queue, job_id=job_id, attempt=attempt, code=e.code, delay_s=round(delay))
                else:
                    log.error("job_failed_final", queue=self.queue, job_id=job_id, attempt=attempt, code=e.code, error=str(e))
            except Exception as e:  # noqa: BLE001 — unexpected errors are logged and not retried forever
                log.exception("job_crashed", queue=self.queue, job_id=job_id, error=str(e))
            await self.redis.xack(self.stream, CONSUMER_GROUP, msg_id)
        finally:
            self._sem.release()


async def move_due_retries(redis: Redis) -> int:
    """Re-adds retry entries whose backoff has elapsed to their work stream."""
    due = await redis.zrangebyscore(STREAMS["retry"], 0, time.time(), start=0, num=100)
    moved = 0
    for raw in due:
        if await redis.zrem(STREAMS["retry"], raw):  # only one mover wins
            p = json.loads(raw)
            await redis.xadd(STREAMS[p["queue"]], {"jobId": p["jobId"], "data": json.dumps(p["data"]), "attempt": str(p["attempt"])}, maxlen=10000, approximate=True)
            moved += 1
    return moved
