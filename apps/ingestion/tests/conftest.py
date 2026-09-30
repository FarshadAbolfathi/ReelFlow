from __future__ import annotations

import os
import subprocess
import uuid
from collections.abc import AsyncIterator
from pathlib import Path

import asyncpg
import pytest
from redis.asyncio import Redis
from sqlalchemy import text

from reelflow_ingestion.adapters import AdapterRegistry
from reelflow_ingestion.db import make_engine
from reelflow_ingestion.pipeline import Deps
from reelflow_network import NetworkMode

REPO = Path(__file__).resolve().parents[3]
DB_URL = os.environ.get("TEST_DATABASE_URL", "postgresql://reelflow:reelflow_dev_password@127.0.0.1:5434/reelflow_test")
REDIS_URL = os.environ.get("TEST_PY_REDIS_URL", "redis://127.0.0.1:6380/2")
TABLES = ["publish_attempts", "scheduled_posts", "schedules", "media_assets", "contents", "ingestion_requests", "source_configs", "sources", "processing_jobs", "audit_logs", "notifications", "analytics_events", "users"]


@pytest.fixture(scope="session", autouse=True)
def migrated_db() -> None:
    import asyncio

    async def create() -> None:
        conn = await asyncpg.connect(DB_URL.rsplit("/", 1)[0] + "/postgres")
        if not await conn.fetchval("SELECT 1 FROM pg_database WHERE datname = 'reelflow_test'"):
            await conn.execute("CREATE DATABASE reelflow_test")
        await conn.close()

    asyncio.run(create())
    subprocess.run(["npx", "prisma", "migrate", "deploy"], cwd=REPO / "packages" / "database", env={**os.environ, "DATABASE_URL": DB_URL}, check=True, capture_output=True)


@pytest.fixture
async def deps(tmp_path: Path) -> AsyncIterator[Deps]:
    engine = make_engine(DB_URL.replace("postgresql://", "postgresql+asyncpg://"))
    async with engine.begin() as conn:
        await conn.execute(text("TRUNCATE " + ", ".join(f'"{t}"' for t in TABLES) + " CASCADE"))
    redis = Redis.from_url(REDIS_URL)
    await redis.flushdb()
    storage = tmp_path / "storage"
    (storage / "incoming").mkdir(parents=True)
    d = Deps(
        begin=engine.begin,
        redis=redis,
        registry=AdapterRegistry(storage / "inbox", frozenset()),
        storage=storage,
        upload_max_bytes=50 * 1024 * 1024,
        network_mode=NetworkMode.DIRECT,
        proxy=None,
    )
    yield d
    await redis.aclose()
    await engine.dispose()


def make_video(path: Path, *, size: str = "640x360", seconds: int = 4, color_src: str = "testsrc2", bitrate: str = "800k") -> Path:
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"{color_src}=s={size}:r=25", "-t", str(seconds), "-c:v", "libx264", "-b:v", bitrate, "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )
    return path


async def insert_source(deps: Deps, *, platform: str = "LOCAL", vetting: str = "APPROVED", rights: str = "PERMISSION_GRANTED", url: str | None = None, name: str = "Funny Page") -> str:
    sid = str(uuid.uuid4())
    async with deps.begin() as conn:
        await conn.execute(
            text(
                'INSERT INTO sources (id, name, url, platform, active, "vettingStatus", "rightsStatus", "approvalRequired", "attributionRequired", "attributionText", "createdAt", "updatedAt") '
                "VALUES (:id, :name, :url, CAST(:platform AS \"Platform\"), true, CAST(:vetting AS \"SourceVettingStatus\"), CAST(:rights AS \"RightsStatus\"), true, true, '🎬 via Funny Page', now(), now())"
            ),
            {"id": sid, "name": name, "url": url, "platform": platform, "vetting": vetting, "rights": rights},
        )
        await conn.execute(
            text('INSERT INTO source_configs (id, "sourceId", "allowedMediaTypes", "importFrequencyMinutes", "maxItemsPerInterval", "adapterOptions", "updatedAt") VALUES (:id, :sid, ARRAY[\'VIDEO\',\'IMAGE\']::"MediaType"[], 60, 5, \'{}\', now())'),
            {"id": str(uuid.uuid4()), "sid": sid},
        )
    return sid


async def insert_upload(deps: Deps, file: Path, *, source_id: str | None = None, rights: str = "USER_OWNS") -> str:
    rid = str(uuid.uuid4())
    key = f"incoming/{rid}.bin"
    (deps.storage / key).write_bytes(file.read_bytes())
    async with deps.begin() as conn:
        await conn.execute(
            text(
                'INSERT INTO ingestion_requests (id, kind, "sourceId", "localKey", metadata, status, "networkMode", attempts, "createdAt", "updatedAt") '
                "VALUES (:id, 'LOCAL_FILE', :sid, :key, CAST(:meta AS jsonb), 'QUEUED', 'DIRECT', 0, now(), now())"
            ),
            {"id": rid, "sid": source_id, "key": key, "meta": '{"rightsStatus": "%s", "caption": "uploaded"}' % rights},
        )
    return rid
