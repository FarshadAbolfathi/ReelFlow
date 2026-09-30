"""Centralized HTTP client for the ingestion engine.

Every network job constructs this with an explicit NetworkMode. In PROXY mode
it FAILS CLOSED: if the proxy is not healthy it raises NetworkUnavailableError
and never falls back to a direct connection.
"""

from __future__ import annotations

import hashlib
import os
import time
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
import structlog

from .proxy_config import NetworkMode
from .proxy_health import Health, HealthResult
from .redaction import redact_string
from .ssrf import assert_public_destination, validate_public_url

log = structlog.get_logger("network_client")


class NetworkUnavailableError(RuntimeError):
    code = "NETWORK_UNAVAILABLE"


class SourceUnavailableError(RuntimeError):
    code = "SOURCE_UNAVAILABLE"


class MediaTooLargeError(RuntimeError):
    code = "MEDIA_INVALID"


HealthCheck = Callable[[], Awaitable[HealthResult]]


@dataclass
class DownloadResult:
    path: Path
    bytes: int
    sha256: str
    content_type: str | None
    final_url: str


class NetworkClient:
    def __init__(
        self,
        mode: NetworkMode,
        *,
        proxy_url: str | None = None,
        health_check: HealthCheck | None = None,
        health_cache_s: float = 30.0,
        ssrf_protection: bool = True,
        timeout_s: float = 60.0,
        max_redirects: int = 5,
        user_agent: str = "ReelFlow/0.1 (+local content manager)",
        job_id: str | None = None,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if mode is NetworkMode.PROXY and not proxy_url:
            raise NetworkUnavailableError("PROXY mode requires a proxy URL")
        if mode is NetworkMode.PROXY and health_check is None:
            raise NetworkUnavailableError("PROXY mode requires a health check")
        self.mode = mode
        self.proxy_url = proxy_url
        self._health_check = health_check
        self._health_cache_s = health_cache_s
        self._last_health: HealthResult | None = None
        self._last_health_at = 0.0
        self.ssrf_protection = ssrf_protection
        self.max_redirects = max_redirects
        self.job_id = job_id
        # trust_env=False: HTTP(S)_PROXY / ALL_PROXY in the environment are ignored,
        # so no request ever inherits an unexpected global network configuration.
        self._client = httpx.AsyncClient(
            proxy=proxy_url if mode is NetworkMode.PROXY else None,
            trust_env=False,
            timeout=timeout_s,
            follow_redirects=False,
            headers={"user-agent": user_agent},
            transport=transport,
        )

    async def __aenter__(self) -> "NetworkClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._client.aclose()

    @property
    def last_health(self) -> HealthResult | None:
        return self._last_health

    async def assert_available(self) -> None:
        """Fail closed: PROXY mode requires a healthy proxy before any request."""
        if self.mode is NetworkMode.DIRECT:
            return
        stale = time.monotonic() - self._last_health_at > self._health_cache_s
        if self._last_health is None or stale or self._last_health.status is Health.UNAVAILABLE:
            assert self._health_check is not None
            self._last_health = await self._health_check()
            self._last_health_at = time.monotonic()
        if self._last_health.status is Health.UNAVAILABLE:
            raise NetworkUnavailableError(f"Proxy unavailable ({self._last_health.failed_step}): {self._last_health.error}")

    def _validate(self, url: str) -> None:
        if not self.ssrf_protection:
            return
        validate_public_url(url)
        # In PROXY mode DNS is resolved by the proxy; local resolution may be
        # censored/poisoned, so only the syntactic checks above apply.
        if self.mode is NetworkMode.DIRECT:
            assert_public_destination(url)

    async def request(self, method: str, url: str, **kwargs) -> httpx.Response:
        await self.assert_available()
        started = time.monotonic()
        current = url
        for _ in range(self.max_redirects + 1):
            self._validate(current)
            try:
                resp = await self._client.request(method, current, **kwargs)
            except httpx.HTTPError as e:
                host = urlsplit(current).hostname
                msg = redact_string(f"{method} {host} failed: {type(e).__name__}: {e}")
                log.warning("network_request_failed", job_id=self.job_id, mode=self.mode.value, host=host, error=msg)
                if self.mode is NetworkMode.PROXY:
                    raise NetworkUnavailableError(msg) from e
                raise SourceUnavailableError(msg) from e
            if resp.is_redirect and "location" in resp.headers:
                await resp.aclose()
                current = urljoin(current, resp.headers["location"])
                continue
            log.info(
                "network_request",
                job_id=self.job_id,
                mode=self.mode.value,
                host=urlsplit(current).hostname,
                status=resp.status_code,
                duration_ms=int((time.monotonic() - started) * 1000),
            )
            return resp
        raise SourceUnavailableError(f"Too many redirects for {urlsplit(url).hostname}")

    async def get(self, url: str, **kwargs) -> httpx.Response:
        return await self.request("GET", url, **kwargs)

    async def post(self, url: str, **kwargs) -> httpx.Response:
        return await self.request("POST", url, **kwargs)

    @asynccontextmanager
    async def stream(self, url: str, **kwargs) -> AsyncIterator[httpx.Response]:
        """Streams a GET response, following validated redirects."""
        await self.assert_available()
        current = url
        for _ in range(self.max_redirects + 1):
            self._validate(current)
            try:
                req = self._client.build_request("GET", current, **kwargs)
                resp = await self._client.send(req, stream=True)
            except httpx.HTTPError as e:
                err = NetworkUnavailableError if self.mode is NetworkMode.PROXY else SourceUnavailableError
                raise err(redact_string(f"GET {urlsplit(current).hostname} failed: {e}")) from e
            if resp.is_redirect and "location" in resp.headers:
                await resp.aclose()
                current = urljoin(current, resp.headers["location"])
                continue
            try:
                yield resp
            finally:
                await resp.aclose()
            return
        raise SourceUnavailableError("Too many redirects")

    async def download(self, url: str, dest: Path, *, max_bytes: int) -> DownloadResult:
        """Atomic download (temp file + rename) with a byte cap and on-the-fly SHA-256."""
        tmp = dest.with_name(dest.name + ".part")
        digest = hashlib.sha256()
        total = 0
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            async with self.stream(url) as resp:
                if resp.status_code != 200:
                    raise SourceUnavailableError(f"Download returned HTTP {resp.status_code}")
                declared = int(resp.headers.get("content-length") or 0)
                if declared > max_bytes:
                    raise MediaTooLargeError(f"File is larger than the {max_bytes} byte limit")
                fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "wb") as f:
                    async for chunk in resp.aiter_bytes(1 << 16):
                        total += len(chunk)
                        if total > max_bytes:
                            raise MediaTooLargeError("Download exceeded the size limit")
                        digest.update(chunk)
                        f.write(chunk)
                content_type = resp.headers.get("content-type")
                final_url = str(resp.url)
            tmp.replace(dest)
        except BaseException:
            tmp.unlink(missing_ok=True)
            raise
        return DownloadResult(dest, total, digest.hexdigest(), content_type, final_url)

    def subprocess_proxy_args(self) -> list[str]:
        """Proxy flag for child tools like yt-dlp — explicit, never via env vars."""
        return ["--proxy", self.proxy_url] if self.mode is NetworkMode.PROXY and self.proxy_url else ["--proxy", ""]
