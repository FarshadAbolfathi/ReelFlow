"""Instagram session commands from the API/worker (login, identity, publish).

Mirrors packages/core/src/services/instagram-session.ts. Commands carry ids and
file paths only — never passwords or cookies; those stay encrypted in the
database and are read here. Replies go to a short-lived key per command.

Publishing is idempotent per container id: the result is remembered for 30
days, so a retried job returns the earlier post instead of posting twice.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path
from typing import Any

import structlog
from redis.asyncio import Redis
from redis.exceptions import ResponseError

from .instagram_session import InstagramSessions, SessionError, map_exception

log = structlog.get_logger("session_control")

COMMAND_STREAM = "reelflow:igsession:commands"
REPLY_PREFIX = "reelflow:igsession:reply:"
PUBLISHED_PREFIX = "reelflow:igsession:published:"
INFLIGHT_PREFIX = "reelflow:igsession:inflight:"
GROUP = "reelflow-igsession"
PUBLISHED_TTL_S = 30 * 86_400
INFLIGHT_TTL_S = 30 * 60


class SessionControl:
    def __init__(self, redis: Redis, sessions: InstagramSessions, storage: Path, consumer: str, *, concurrency: int = 3) -> None:
        self.redis = redis
        self.sessions = sessions
        self.storage = storage.resolve()
        self.consumer = consumer
        self._sem = asyncio.Semaphore(concurrency)
        self._stopping = asyncio.Event()
        self._tasks: set[asyncio.Task[None]] = set()

    def stop(self) -> None:
        self._stopping.set()

    def _file(self, raw: str) -> Path:
        p = Path(raw).resolve()
        if not p.is_relative_to(self.storage) or not p.is_file():
            raise SessionError("MEDIA_INVALID", "Media file must be an existing file under STORAGE_PATH")
        return p

    async def _publish(self, a: dict[str, Any]) -> dict[str, Any]:
        container = str(a["containerId"])
        done = await self.redis.get(PUBLISHED_PREFIX + container)
        if done:
            return json.loads(done)
        if not await self.redis.set(INFLIGHT_PREFIX + container, "1", ex=INFLIGHT_TTL_S, nx=True):
            raise SessionError("PUBLISH_FAILED", "An earlier upload of this post is still running")
        try:
            result = await self.sessions.publish(
                str(a["externalAccountId"]),
                kind=str(a.get("kind", "REEL")),
                media_type=str(a.get("mediaType", "VIDEO")),
                file_path=self._file(str(a["filePath"])),
                caption=str(a.get("caption") or ""),
            )
            await self.redis.set(PUBLISHED_PREFIX + container, json.dumps(result), ex=PUBLISHED_TTL_S)
            return result
        finally:
            await self.redis.delete(INFLIGHT_PREFIX + container)

    async def execute(self, cmd: str, args: dict[str, Any]) -> dict[str, Any]:
        if cmd == "login":
            return await self.sessions.login(str(args["accountId"]), args.get("verificationCode") or None)
        if cmd == "identity":
            return await self.sessions.identity(str(args["externalAccountId"]))
        if cmd == "publish":
            return await self._publish(args)
        raise SessionError("VALIDATION_FAILED", f"Unknown command {cmd}")

    async def _handle(self, msg_id: bytes, fields: dict[bytes, bytes]) -> None:
        try:
            f = {k.decode(): v.decode() for k, v in fields.items()}
            cid = f.get("id", "")
            cmd = f.get("cmd", "")
            if float(f.get("deadline", "0") or 0) < time.time() and cmd != "publish":
                log.info("session_command_expired", cmd=cmd)  # the caller already gave up
            else:
                try:
                    reply: dict[str, Any] = {"ok": True, "result": await self.execute(cmd, json.loads(f.get("args", "{}")))}
                except Exception as e:  # noqa: BLE001 — every failure is answered, typed
                    err = map_exception(e)
                    reply = {"ok": False, **err.to_dict()}
                log.info("session_command", cmd=cmd, ok=reply["ok"], code=reply.get("code"))
                await self.redis.set(REPLY_PREFIX + cid, json.dumps(reply), ex=300)
            await self.redis.xack(COMMAND_STREAM, GROUP, msg_id)
        finally:
            self._sem.release()

    async def run(self) -> None:
        try:
            await self.redis.xgroup_create(COMMAND_STREAM, GROUP, id="$", mkstream=True)
        except ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise
        while not self._stopping.is_set():
            try:
                resp = await self.redis.xreadgroup(GROUP, self.consumer, {COMMAND_STREAM: ">"}, count=5, block=3000)
            except (ConnectionError, OSError) as e:
                log.error("session_stream_read_failed", error=str(e))
                await asyncio.sleep(2)
                continue
            for _s, messages in resp or []:
                for msg_id, fields in messages:
                    await self._sem.acquire()
                    t = asyncio.create_task(self._handle(msg_id, fields))
                    self._tasks.add(t)
                    t.add_done_callback(self._tasks.discard)
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
