"""Network control plane: answers commands from the API (Settings → Network)
and publishes proxy status to Redis. Mirrors packages/core/src/services/network-control.ts."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from typing import Any

import structlog
from redis.asyncio import Redis
from redis.exceptions import ResponseError
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncConnection

from reelflow_network import NetworkMode, ProxyManager, ProxyStartError

from . import db
from .network_runtime import NetworkRuntime, SshServerCreds
from .repo import now
from .secretbox import decrypt_secret

log = structlog.get_logger("network_control")

COMMAND_STREAM = "reelflow:network:commands"
STATUS_KEY = "reelflow:network:status"
REPLY_PREFIX = "reelflow:network:reply:"
GROUP = "reelflow-network"
COMMAND_TIMEOUT_S = 30.0

ConnFactory = Callable[[], AbstractAsyncContextManager[AsyncConnection]]


def server_aad(server_id: str) -> str:
    return f"network_server:{server_id}"


class NetworkControl:
    def __init__(self, redis: Redis, manager: ProxyManager, consumer: str, *, begin: ConnFactory | None = None, runtime: NetworkRuntime | None = None, key: bytes | None = None) -> None:
        self.redis = redis
        self.manager = manager
        self.consumer = consumer
        self.begin = begin
        self.runtime = runtime
        self.key = key
        self._stopping = asyncio.Event()

    def stop(self) -> None:
        self._stopping.set()

    async def publish_status(self) -> dict:
        status = (await self.manager.status()).to_dict()
        if self.runtime is not None:
            status["mode"] = self.runtime.mode.value.lower()
            status["activeServerId"] = self.runtime.active_server_id
        await self.redis.set(STATUS_KEY, json.dumps(status), ex=120)
        return status

    async def _load_server(self, server_id: str) -> SshServerCreds:
        assert self.begin and self.key
        s = db.network_servers
        async with self.begin() as conn:
            row = (await conn.execute(select(s).where(s.c.id == server_id))).mappings().first()
        if row is None:
            raise ValueError("Server not found")
        password = decrypt_secret(row["encryptedPassword"], self.key, server_aad(server_id))
        return SshServerCreds(id=server_id, host=row["host"], port=row["port"], username=row["username"], password=password)

    async def _persist_state(self, *, mode: NetworkMode | None = None, active_server_id: str | None | type = Ellipsis) -> None:
        assert self.begin
        values: dict[str, Any] = {"updatedAt": now()}
        if mode is not None:
            values["mode"] = mode.value
        if active_server_id is not Ellipsis:
            values["activeServerId"] = active_server_id
        st = db.network_state
        async with self.begin() as conn:
            res = await conn.execute(update(st).where(st.c.id == "singleton").values(**values))
            if res.rowcount == 0:
                await conn.execute(pg_insert(st).values(id="singleton", mode=(mode or NetworkMode.DIRECT).value, activeServerId=None if active_server_id is Ellipsis else active_server_id, updatedAt=now()))

    async def execute(self, cmd: str, args: dict[str, Any]) -> tuple[bool, str]:
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
            if cmd == "set_mode":
                assert self.runtime
                mode = NetworkMode(str(args["mode"]).upper())
                self.runtime.mode = mode
                await self._persist_state(mode=mode)
                return True, f"Network mode set to {mode.value}"
            if cmd == "select_server":
                assert self.runtime
                server_id = args.get("serverId")
                if not server_id or server_id == "builtin":
                    await asyncio.wait_for(self.runtime.apply_server(None), COMMAND_TIMEOUT_S)
                    await self._persist_state(active_server_id=None)
                    return True, "Using the built-in proxy"
                creds = await self._load_server(str(server_id))
                await asyncio.wait_for(self.runtime.apply_server(creds), COMMAND_TIMEOUT_S)
                await self._persist_state(active_server_id=creds.id)
                return True, f"Tunnel to {creds.host} is active"
            if cmd == "test_server":
                assert self.runtime
                creds = await self._load_server(str(args["serverId"]))
                h = await asyncio.wait_for(self.runtime.test_server(creds), COMMAND_TIMEOUT_S)
                ok = h.status.value != "UNAVAILABLE"
                return ok, f"{h.status.value}" + (f" ({h.latency_ms} ms)" if h.latency_ms else f": {h.error}")
            return False, f"Unknown command {cmd}"
        except ProxyStartError as e:
            return False, str(e)
        except TimeoutError:
            # Bounds every branch above against a wedged subprocess (e.g. a stuck SSH
            # handshake) — never let one bad command block the whole control loop.
            return False, "Timed out — the SSH server may be slow or unreachable"
        except (ValueError, RuntimeError) as e:
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
                    args = json.loads(f.get("args") or "{}")
                    ok, message = await self.execute(f.get("cmd", ""), args)
                    log.info("network_command", cmd=f.get("cmd"), ok=ok, message=message, requested_by=f.get("by"))
                    status = await self.publish_status()
                    await self.redis.set(REPLY_PREFIX + f.get("id", ""), json.dumps({"ok": ok, "message": message, "status": status}), ex=120)
                    await self.redis.xack(COMMAND_STREAM, GROUP, msg_id)
