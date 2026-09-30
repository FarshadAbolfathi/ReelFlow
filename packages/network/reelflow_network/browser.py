"""Isolated browser context for workflows where browser use is legitimately
supported (e.g. an OAuth consent page). Uses a dedicated profile directory and
a per-process proxy setting — never the system browser, never other profiles.

Playwright is optional: `pip install playwright && playwright install chromium`.
No stealth plugins, fingerprint spoofing or human-imitation are used or allowed.
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from .client import NetworkUnavailableError
from .proxy_config import NetworkMode
from .proxy_manager import ProxyManager


@asynccontextmanager
async def isolated_browser(profile_dir: Path, mode: NetworkMode, manager: ProxyManager | None, *, headless: bool = True) -> Any:
    try:
        from playwright.async_api import async_playwright  # type: ignore[import-not-found]
    except ImportError as e:  # pragma: no cover - optional dependency
        raise RuntimeError("Playwright is not installed; browser workflows are disabled") from e

    proxy = None
    if mode is NetworkMode.PROXY:
        if manager is None:
            raise NetworkUnavailableError("PROXY mode requires the proxy manager")
        health = await manager.health_check()
        if health.status.value == "UNAVAILABLE":
            raise NetworkUnavailableError(f"Proxy unavailable: {health.error}")  # fail closed
        proxy = {"server": f"http://{manager.config.address}"}

    profile_dir.mkdir(parents=True, exist_ok=True)
    async with async_playwright() as pw:
        ctx = await pw.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=headless,
            proxy=proxy,
            # An explicit empty bypass list keeps even localhost traffic on the declared path.
            args=["--proxy-bypass-list=<-loopback>"] if proxy else ["--no-proxy-server"],
        )
        try:
            yield ctx
        finally:
            await ctx.close()
