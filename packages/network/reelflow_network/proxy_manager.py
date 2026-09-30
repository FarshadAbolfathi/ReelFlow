"""Lifecycle of the local VPS proxy, scoped to ReelFlow.

Ownership model:
  EXTERNAL — something (e.g. launchd `com.farshad.vpnproxy`) already serves the
             port. ReelFlow uses it and never stops or restarts it.
  MANAGED  — ReelFlow started sing-box itself (only if PROXY_MANAGED_START=true)
             and is responsible for stopping it on shutdown.
  NONE     — nothing running.

The manager never alters machine-wide networking: it only runs sing-box with a
config that has been checked to contain no TUN inbound and no system-proxy flag.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum

import structlog

from .process_runner import ProcessRunner
from .proxy_config import NetworkMode, ProxyConfig, validate_project, validate_runtime
from .proxy_health import Health, HealthResult, check_proxy, tcp_probe

log = structlog.get_logger("proxy_manager")


class Ownership(StrEnum):
    EXTERNAL = "external"
    MANAGED = "managed"
    NONE = "none"


class ProxyStartError(RuntimeError):
    pass


@dataclass
class ProxyStatus:
    mode: str
    provider: str
    proxy_address: str | None
    ownership: Ownership
    process_running: bool
    health: Health
    last_check_at: str | None
    latency_ms: int | None
    last_error: str | None
    runtime_valid: bool
    runtime_problems: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """camelCase for the Node API (see packages/core/src/services/network-control.ts)."""
        return {
            "mode": self.mode,
            "provider": self.provider,
            "proxyAddress": self.proxy_address,
            "ownership": self.ownership.value,
            "processRunning": self.process_running,
            "health": self.health.value,
            "lastCheckAt": self.last_check_at,
            "latencyMs": self.latency_ms,
            "lastError": self.last_error,
            "runtimeValid": self.runtime_valid,
            "runtimeProblems": self.runtime_problems,
            "engineHeartbeatAt": datetime.now(UTC).isoformat(),
        }


class ProxyManager:
    def __init__(self, config: ProxyConfig, runner_factory=ProcessRunner) -> None:
        self.config = config
        self._runner_factory = runner_factory
        self._runner: ProcessRunner | None = None
        self._last: HealthResult | None = None
        self._lock = asyncio.Lock()

    # ── Introspection ───────────────────────────────────────────────────
    async def _port_open(self) -> bool:
        try:
            await tcp_probe(self.config.host, self.config.port, 2.0)
            return True
        except (OSError, TimeoutError):
            return False

    @property
    def ownership(self) -> Ownership:
        if self._runner and self._runner.running:
            return Ownership.MANAGED
        return Ownership.EXTERNAL if self._last and self._last.failed_step != "tcp" else Ownership.NONE

    def runtime_problems(self) -> list[str]:
        return validate_project(self.config) + validate_runtime(self.config)

    async def status(self) -> ProxyStatus:
        if self.config.mode is NetworkMode.DIRECT:
            health, last = Health.DISABLED, self._last
        else:
            last = self._last
            health = last.status if last else Health.UNAVAILABLE
        managed = self._runner is not None and self._runner.running
        ownership = Ownership.MANAGED if managed else (Ownership.EXTERNAL if await self._port_open() else Ownership.NONE)
        # Always surface config risks (e.g. a listener on 0.0.0.0 exposes the proxy to the LAN),
        # even for an external proxy ReelFlow does not manage.
        problems = self.runtime_problems() if self.config.runtime_path else validate_project(self.config)
        return ProxyStatus(
            mode=self.config.mode.value.lower(),
            provider=self.config.provider,
            proxy_address=self.config.address if self.config.mode is NetworkMode.PROXY else None,
            ownership=ownership,
            process_running=ownership is not Ownership.NONE,
            health=health,
            last_check_at=last.checked_at.isoformat() if last else None,
            latency_ms=last.latency_ms if last else None,
            last_error=last.error if last else None,
            runtime_valid=not problems,
            runtime_problems=problems,
        )

    # ── Health ──────────────────────────────────────────────────────────
    async def health_check(self) -> HealthResult:
        self._last = await check_proxy(
            self.config.host, self.config.port, self.config.proxy_url, self.config.health_url, self.config.health_timeout_s
        )
        log.info("proxy_health", status=self._last.status.value, latency_ms=self._last.latency_ms, failed_step=self._last.failed_step)
        return self._last

    def get_proxy_url(self) -> str:
        return self.config.proxy_url

    # ── Lifecycle ───────────────────────────────────────────────────────
    async def start(self) -> ProxyStatus:
        """Idempotent: re-uses an already running proxy instead of starting a duplicate."""
        async with self._lock:
            if self._runner and self._runner.running:
                return await self.status()
            if await self._port_open():
                log.info("proxy_already_running", address=self.config.address, ownership="external")
                await self.health_check()
                return await self.status()
            if not self.config.managed_start:
                raise ProxyStartError(
                    f"No proxy is listening on {self.config.address} and PROXY_MANAGED_START=false. "
                    "Start the VPS proxy (e.g. its launchd agent) or enable managed start."
                )
            problems = self.runtime_problems()
            if problems:
                raise ProxyStartError("Refusing to start proxy: " + "; ".join(problems))
            assert self.config.binary_path and self.config.config_path
            runner = self._runner_factory(
                argv=[str(self.config.binary_path), "run", "-c", str(self.config.config_path)],
                cwd=self.config.runtime_path,
            )
            await runner.start()
            self._runner = runner
            deadline = asyncio.get_running_loop().time() + self.config.startup_timeout_s
            while asyncio.get_running_loop().time() < deadline:
                if not runner.running:
                    tail = "\n".join(runner.output_tail(10))
                    self._runner = None
                    raise ProxyStartError(f"Proxy exited during startup (code {runner.returncode}): {tail}")
                if await self._port_open():
                    log.info("proxy_started", pid=runner.pid, address=self.config.address)
                    await self.health_check()
                    return await self.status()
                await asyncio.sleep(0.25)
            await runner.stop()
            self._runner = None
            raise ProxyStartError(f"Proxy did not open {self.config.address} within {self.config.startup_timeout_s}s")

    async def stop(self) -> ProxyStatus:
        """Stops only a proxy ReelFlow started. An external proxy is left untouched."""
        async with self._lock:
            if self._runner:
                log.info("proxy_stopping", pid=self._runner.pid)
                await self._runner.stop()
                self._runner = None
            elif await self._port_open():
                log.info("proxy_stop_skipped", reason="external proxy is not owned by ReelFlow")
        return await self.status()

    async def restart(self) -> ProxyStatus:
        if self._runner is None and await self._port_open():
            # External: ReelFlow cannot restart what it does not own; re-check instead.
            await self.health_check()
            return await self.status()
        await self.stop()
        return await self.start()

    def output_tail(self, lines: int = 20) -> list[str]:
        return self._runner.output_tail(lines) if self._runner else []
