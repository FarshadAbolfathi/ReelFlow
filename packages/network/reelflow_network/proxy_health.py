"""Two-step proxy health check: TCP listener, then a real request through the tunnel."""

from __future__ import annotations

import asyncio
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from enum import StrEnum

import httpx

from .redaction import redact_string


class Health(StrEnum):
    HEALTHY = "HEALTHY"
    DEGRADED = "DEGRADED"
    UNAVAILABLE = "UNAVAILABLE"
    DISABLED = "DISABLED"


@dataclass(frozen=True)
class HealthResult:
    status: Health
    checked_at: datetime
    latency_ms: int | None = None
    failed_step: str | None = None  # "tcp" | "http"
    error: str | None = None

    def to_dict(self) -> dict:
        d = asdict(self)
        d["status"] = self.status.value
        d["checked_at"] = self.checked_at.isoformat()
        return d


async def tcp_probe(host: str, port: int, timeout: float) -> None:
    _reader, writer = await asyncio.wait_for(asyncio.open_connection(host, port), timeout)
    writer.close()
    await writer.wait_closed()


async def _probe_once(proxy_url: str, health_url: str, timeout: float) -> tuple[int | None, str | None]:
    started = time.monotonic()
    try:
        # trust_env=False: never pick up HTTP(S)_PROXY from the environment.
        async with httpx.AsyncClient(proxy=proxy_url, timeout=timeout, trust_env=False, follow_redirects=False) as client:
            r = await client.get(health_url)
    except httpx.HTTPError as e:
        return None, redact_string(f"{type(e).__name__}: {e}")
    if r.status_code not in (200, 204):
        return None, f"health URL returned {r.status_code}"
    return int((time.monotonic() - started) * 1000), None


async def check_proxy(host: str, port: int, proxy_url: str, health_url: str, timeout: float, attempts: int = 3) -> HealthResult:
    """TCP check, then up to `attempts` HTTP probes through the tunnel.

    all probes fail            → UNAVAILABLE (jobs fail closed)
    some fail / slow           → DEGRADED   (usable; failed requests are retried by jobs)
    first probe fast and fine  → HEALTHY
    """
    now = lambda: datetime.now(UTC)  # noqa: E731
    try:
        await tcp_probe(host, port, min(timeout, 5.0))
    except (OSError, TimeoutError) as e:
        return HealthResult(Health.UNAVAILABLE, now(), failed_step="tcp", error=f"nothing listening on {host}:{port}: {e or 'timeout'}")
    errors: list[str] = []
    for i in range(max(1, attempts)):
        latency, err = await _probe_once(proxy_url, health_url, timeout)
        if latency is not None:
            degraded = bool(errors) or latency > timeout * 1000 / 2
            return HealthResult(Health.DEGRADED if degraded else Health.HEALTHY, now(), latency, None, f"{len(errors)} failed probe(s): {errors[-1]}" if errors else None)
        errors.append(err or "unknown error")
        if i < attempts - 1:
            await asyncio.sleep(0.5 * (i + 1))
    return HealthResult(Health.UNAVAILABLE, now(), failed_step="http", error=f"{len(errors)}/{attempts} probes failed: {errors[-1]}")
