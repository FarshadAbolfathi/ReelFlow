"""Network control plane: answers commands from the API (Settings → Network)
and publishes proxy status to Redis. Mirrors packages/core/src/services/network-control.ts."""

from __future__ import annotations

import asyncio
import json

import structlog
from redis.asyncio import Redis
from redis.exceptions import ResponseError

from reelflow_network import NetworkMode, ProxyManager, ProxyStartError

log = structlog.get_logger("network_control")

COMMAND_STREAM = "reelflow:network:commands"
STATUS_KEY = "reelflow:network:status"
REPLY_PREFIX = "reelflow:network:reply:"
GROUP = "reelflow-network"


class NetworkControl:
    def __init__(self, redis: Redis, manager: ProxyManager, consumer: str) -> None:
        self.redis = redis
        self.manager = manager
        self.consumer = consumer
        self._stopping = asyncio.Event()

    def stop(self) -> None:
        self._stopping.set()

    async def publish_status(self) -> dict:
        status = (await self.manager.status()).to_dict()
        await self.redis.set(STATUS_KEY, json.dumps(status), ex=120)
        return status

    async def execute(self, cmd: str) -> tuple[bool, str]:
        m = self.manager
        try:
            if cmd == "status":
                return True, "ok"
            if cmd == "test":
                if m.config.mode is NetworkMode.DIRECT:
                    return True, "Network mode is DIRECT — no proxy in use"
                h = await m.health_check()
                return h.status.value != "UNAVAILABLE", f"{h.status.value}" + (f" ({h.latency_ms} ms)" if h.latency_ms else f": {h.error}")
            if cmd == "start":
                s = await m.start()
                return True, f"Proxy {s.ownership.value} on {m.config.address}"
            if cmd == "stop":
                s = await m.stop()
                return True, "Stopped" if s.ownership.value == "none" else "External proxy left running (not owned by ReelFlow)"
            if cmd == "restart":
                s = await m.restart()
                return True, f"Proxy {s.ownership.value}"
            return False, f"Unknown command {cmd}"
        except ProxyStartError as e:
            return False, str(e)

    async def run(self) -> None:
        try:
            await self.redis.xgroup_create(COMMAND_STREAM, GROUP, id="$", mkstream=True)
        except ResponseError as e:
            if "BUSYGROUP" not in str(e):
                raise
        while not self._stopping.is_set():
            resp = await self.redis.xreadgroup(GROUP, self.consumer, {COMMAND_STREAM: ">"}, count=5, block=3000)
            for _s, messages in resp or []:
                for msg_id, fields in messages:
                    f = {k.decode(): v.decode() for k, v in fields.items()}
                    ok, message = await self.execute(f.get("cmd", ""))
                    log.info("network_command", cmd=f.get("cmd"), ok=ok, message=message, requested_by=f.get("by"))
                    status = await self.publish_status()
                    await self.redis.set(REPLY_PREFIX + f.get("id", ""), json.dumps({"ok": ok, "message": message, "status": status}), ex=120)
                    await self.redis.xack(COMMAND_STREAM, GROUP, msg_id)
