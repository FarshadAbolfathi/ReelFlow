"""Entry point: `python -m reelflow_ingestion` (or `npm run dev:ingestion`)."""

from __future__ import annotations

import asyncio
import signal

import structlog
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from redis.asyncio import Redis

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine

from reelflow_network import NetworkMode, ProxyManager

from . import db
from .adapters import AdapterRegistry
from .control import NetworkControl
from .db import make_engine
from .instagram_session import InstagramSessions
from .logging_setup import configure_logging
from .network_runtime import NetworkRuntime
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

    runtime = NetworkRuntime(manager, settings.proxy.mode)
    encryption_key = load_key(settings.encryption_key) if settings.encryption_key else None
    control = NetworkControl(redis, manager, settings.consumer_name, begin=engine.begin, runtime=runtime, key=encryption_key)
    await _restore_network_state(engine, control)

    sessions = None
    if encryption_key:
        sessions = InstagramSessions(engine.begin, encryption_key, runtime=runtime, transport=settings.instagram_transport)
    else:
        log.warning("instagram_sessions_disabled", reason="ENCRYPTION_KEY is not set")

    deps = Deps(
        begin=engine.begin,
        redis=redis,
        registry=AdapterRegistry(settings.inbox_path, settings.ytdlp_allowed_extractors, sessions),
        storage=settings.storage_path,
        upload_max_bytes=settings.upload_max_bytes,
        runtime=runtime,
    )
    consumers = [
        StreamConsumer(redis, "content-discovery", lambda d, j, a: run_discovery(deps, d, j, a), settings.consumer_name, concurrency=1),
        StreamConsumer(redis, "media-download", lambda d, j, a: run_ingest(deps, d, j, a), settings.consumer_name, concurrency=2),
    ]
    session_control = SessionControl(redis, sessions, settings.storage_path, settings.consumer_name) if sessions else None

    async def health_job() -> None:
        if runtime.mode is NetworkMode.PROXY:
            if await runtime.ensure_alive():
                log.info("ssh_tunnel_reconnected", server_id=runtime.active_server_id)
            await manager.health_check()

    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(move_due_retries, "interval", seconds=15, args=[redis], id="retries", max_instances=1)
    scheduler.add_job(control.publish_status, "interval", seconds=20, id="status", max_instances=1)
    scheduler.add_job(health_job, "interval", seconds=60, id="health", max_instances=1)
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


async def _restore_network_state(engine: AsyncEngine, control: NetworkControl) -> None:
    """Applies the last mode/server chosen from Settings → Network, if any,
    before the engine starts handling jobs. Falls back silently to the
    .env-configured builtin proxy if nothing was ever persisted."""
    async with engine.begin() as conn:
        row = (await conn.execute(select(db.network_state).where(db.network_state.c.id == "singleton"))).mappings().first()
    if row is None:
        return
    ok, message = await control.execute("set_mode", {"mode": row["mode"]})
    if not ok:
        log.warning("network_state_restore_failed", step="set_mode", message=message)
    if control.key is not None:
        ok, message = await control.execute("select_server", {"serverId": row["activeServerId"] or "builtin"})
        if not ok:
            log.warning("network_state_restore_failed", step="select_server", message=message)


def run() -> None:
    asyncio.run(main())


if __name__ == "__main__":
    run()
