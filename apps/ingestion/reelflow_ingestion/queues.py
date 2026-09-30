"""Stream names and helpers — mirror of packages/types/src/queues.ts (STREAMS, jobIds)."""

from __future__ import annotations

import json
import re
from typing import Any

from redis.asyncio import Redis

STREAMS = {
    "content-discovery": "reelflow:stream:content-discovery",
    "media-download": "reelflow:stream:media-download",
    "events": "reelflow:events:ingestion",
    "retry": "reelflow:stream-retry",
}
CONSUMER_GROUP = "reelflow-ingestion"
DEDUPE_PREFIX = "reelflow:stream-dedupe:"


def jid(*parts: str | int) -> str:
    return ".".join(re.sub(r"[:\s]", "_", str(p)) for p in parts)


async def enqueue_python_job(redis: Redis, queue: str, data: dict[str, Any], job_id: str) -> bool:
    """Adds work once per job id (same 7-day dedupe window as the Node side)."""
    if not await redis.set(DEDUPE_PREFIX + job_id, "1", ex=7 * 86_400, nx=True):
        return False
    await redis.xadd(STREAMS[queue], {"jobId": job_id, "data": json.dumps(data), "attempt": "1"}, maxlen=10000, approximate=True)
    return True
