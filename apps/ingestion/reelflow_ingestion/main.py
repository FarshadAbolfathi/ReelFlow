"""Entry point: `python -m reelflow_ingestion` (or `npm run dev:ingestion`)."""

from __future__ import annotations

import asyncio
import signal

import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from redis.asyncio import Redis

from reelflow_network import NetworkMode, ProxyManager

from .adapters import AdapterRegistry
from .control import NetworkControl
from .db import make_engine
from .instagram_session import InstagramSessions
from .logging_setup import configure_logging
from .pipeline import Deps, run_discovery, run_ingest
from .secretbox import load_key
from .session_control import SessionControl
from .settings import load_settings
from .streams import StreamConsumer, move_due_retries

log = structlog.get_logger("ingestion")


async def main() -> None:
    settings = load_settings()
    configure_logging(settings.log_level)
    engine = make_engine(settings.async_database_url)
    redis = Redis.from_url(settings.redis_url)
    manager = ProxyManager(settings.proxy)

    problems = manager.runtime_problems()
    if problems:
        log.warning("vps_proxy_config_problems", problems=problems)
    if settings.proxy.mode is NetworkMode.PROXY:
        health = await manager.health_check()
        log.info("network_mode", mode="PROXY", address=settings.proxy.address, health=health.status.value)
        if health.status.value == "UNAVAILABLE" and settings.proxy.managed_start:
            try:
                await manager.start()
            except Exception as e:  # noqa: BLE001 — jobs will fail closed until the proxy is healthy
                log.error("proxy_start_failed", error=str(e))
    else:
        log.info("network_mode", mode="DIRECT")

    proxy = manager if settings.proxy.mode is NetworkMode.PROXY else None
    sessions = None
    if settings.encryption_key:
        sessions = InstagramSessions(engine.begin, load_key(settings.encryption_key), network_mode=settings.proxy.mode, proxy=proxy, transport=settings.instagram_transport)
    else:
        log.warning("instagram_sessions_disabled", reason="ENCRYPTION_KEY is not set")

    deps = Deps(
        begin=engine.begin,
        redis=redis,
        registry=AdapterRegistry(settings.inbox_path, settings.ytdlp_allowed_extractors, sessions),
        storage=settings.storage_path,
        upload_max_bytes=settings.upload_max_bytes,
        network_mode=settings.proxy.mode,
        proxy=proxy,
    )
    consumers = [
        StreamConsumer(redis, "content-discovery", lambda d, j, a: run_discovery(deps, d, j, a), settings.consumer_name, concurrency=1),
        StreamConsumer(redis, "media-download", lambda d, j, a: run_ingest(deps, d, j, a), settings.consumer_name, concurrency=2),
    ]
    control = NetworkControl(redis, manager, settings.consumer_name)
    session_control = SessionControl(redis, sessions, settings.storage_path, settings.consumer_name) if sessions else None

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(move_due_retries, "interval", seconds=15, args=[redis], id="retries", max_instances=1)
    scheduler.add_job(control.publish_status, "interval", seconds=20, id="status", max_instances=1)
    if settings.proxy.mode is NetworkMode.PROXY:
        scheduler.add_job(manager.health_check, "interval", seconds=60, id="health", max_instances=1)
    scheduler.start()
    await control.publish_status()

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)

    tasks = [asyncio.create_task(c.run()) for c in consumers] + [asyncio.create_task(control.run())]
    if session_control:
        tasks.append(asyncio.create_task(session_control.run()))
    log.info("ingestion_started", consumer=settings.consumer_name, storage=str(settings.storage_path))
    await stop.wait()

    log.info("ingestion_stopping")
    for c in consumers:
        c.stop()
    control.stop()
    if session_control:
        session_control.stop()
    scheduler.shutdown(wait=False)
    await asyncio.wait(tasks, timeout=30)
    await manager.stop()  # stops only a proxy ReelFlow started itself
    await redis.aclose()
    await engine.dispose()


def run() -> None:
    asyncio.run(main())


if __name__ == "__main__":
    run()
