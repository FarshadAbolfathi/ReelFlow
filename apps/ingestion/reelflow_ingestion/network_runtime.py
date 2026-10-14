"""Live network mode/target, swappable from the Settings → Network panel without
restarting the engine. `Deps.runtime` and `InstagramSessions.runtime` hold a
reference to the single instance built in main.py and read `.mode`/`.manager`
fresh on every job — never a value snapshotted once at startup."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from datetime import UTC, datetime

import structlog
from reelflow_network import Health, NetworkMode, ProcessRunner, ProxyConfig, ProxyManager, ProxyScheme, check_proxy
from reelflow_network.proxy_health import HealthResult, tcp_probe

log = structlog.get_logger("network_runtime")

SSH_PROXY_PORT = 10811
SSH_TEST_PORT = 10812
SSH_BIND_TIMEOUT_S = 10.0


def _ssh_argv(bind_port: int, host: str, port: int, username: str) -> list[str]:
    return [
        "sshpass", "-e", "ssh", "-N", "-D", f"127.0.0.1:{bind_port}",
        "-p", str(port),
        "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ServerAliveInterval=30",
        "-o", "ServerAliveCountMax=3",
        "-o", "ConnectTimeout=10",
        f"{username}@{host}",
    ]  # fmt: skip


async def _wait_bound(port: int, timeout: float) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        try:
            await tcp_probe("127.0.0.1", port, 1.0)
            return
        except (OSError, TimeoutError):
            await asyncio.sleep(0.25)
    raise TimeoutError(f"SSH tunnel did not bind 127.0.0.1:{port} within {timeout}s")


@dataclass
class SshServerCreds:
    id: str
    host: str
    port: int
    username: str
    password: str


class NetworkRuntime:
    """Owns: the current mode, the active proxy target, and the one persistent
    SSH tunnel subprocess (if a custom server is selected)."""

    def __init__(self, manager: ProxyManager, mode: NetworkMode) -> None:
        self.manager = manager
        self.mode = mode
        self.builtin_config = manager.config
        self.active_server_id: str | None = None
        self._tunnel: ProcessRunner | None = None
        self._active_creds: SshServerCreds | None = None
        self._lock = asyncio.Lock()
        self._test_lock = asyncio.Lock()

    async def apply_server(self, server: SshServerCreds | None) -> None:
        """`None` restores the built-in (.env-configured) proxy."""
        async with self._lock:
            if self._tunnel is not None:
                await self._tunnel.stop()
                self._tunnel = None
            if server is None:
                self._active_creds = None
                self.manager.update_config(self.builtin_config)
                self.active_server_id = None
                return
            runner = ProcessRunner(
                argv=_ssh_argv(SSH_PROXY_PORT, server.host, server.port, server.username),
                env={**os.environ, "SSHPASS": server.password},
            )
            await runner.start()
            try:
                await _wait_bound(SSH_PROXY_PORT, SSH_BIND_TIMEOUT_S)
            except TimeoutError:
                tail = "\n".join(runner.output_tail(10))
                await runner.stop()
                raise RuntimeError(f"SSH tunnel to {server.host} did not come up: {tail}") from None
            self._tunnel = runner
            self._active_creds = server
            self.active_server_id = server.id
            self.manager.update_config(
                ProxyConfig(
                    mode=NetworkMode.PROXY,
                    scheme=ProxyScheme.SOCKS5,
                    host="127.0.0.1",
                    port=SSH_PROXY_PORT,
                    health_url=self.builtin_config.health_url,
                    health_timeout_s=self.builtin_config.health_timeout_s,
                )
            )
            log.info("ssh_tunnel_active", server_id=server.id, host=server.host)

    async def ensure_alive(self) -> bool:
        """Self-heals a dropped SSH tunnel (free/shared SSH providers can reset
        idle or long-lived connections without warning). Call periodically from
        the scheduler; a no-op unless a custom server is selected and its
        process has actually died. Returns True if it reconnected."""
        if self._active_creds is None or (self._tunnel is not None and self._tunnel.running):
            return False
        creds = self._active_creds
        log.warning("ssh_tunnel_dropped", server_id=creds.id, host=creds.host)
        try:
            await self.apply_server(creds)
        except (TimeoutError, RuntimeError) as e:
            log.error("ssh_tunnel_reconnect_failed", server_id=creds.id, error=str(e))
            return False
        return True

    async def test_server(self, server: SshServerCreds) -> HealthResult:
        """Short-lived tunnel on a separate port — never touches the live one."""
        async with self._test_lock:
            runner = ProcessRunner(
                argv=_ssh_argv(SSH_TEST_PORT, server.host, server.port, server.username),
                env={**os.environ, "SSHPASS": server.password},
            )
            await runner.start()
            try:
                await _wait_bound(SSH_TEST_PORT, SSH_BIND_TIMEOUT_S)
                proxy_url = f"socks5h://127.0.0.1:{SSH_TEST_PORT}"
                return await check_proxy(
                    "127.0.0.1", SSH_TEST_PORT, proxy_url, self.builtin_config.health_url, self.builtin_config.health_timeout_s, attempts=1
                )
            except TimeoutError as e:
                return HealthResult(Health.UNAVAILABLE, checked_at=datetime.now(UTC), failed_step="tcp", error=str(e))
            finally:
                await runner.stop()
