"""Database helpers used by the pipeline (audit, notifications, job records)."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import insert, select, update
from sqlalchemy.ext.asyncio import AsyncConnection

from reelflow_network import redact, redact_string

from . import db
from .adapters import SourceRecord


def now() -> datetime:
    # Prisma stores `timestamp(3) without time zone` in UTC.
    return datetime.now(UTC).replace(tzinfo=None)


def new_id() -> str:
    return str(uuid.uuid4())


async def audit(conn: AsyncConnection, action: str, summary: str, entity: tuple[str, str] | None = None, metadata: dict[str, Any] | None = None) -> None:
    await conn.execute(
        insert(db.audit_logs).values(
            id=new_id(),
            action=action,
            actorType="INGESTION",
            actorId=None,
            entityType=entity[0] if entity else None,
            entityId=entity[1] if entity else None,
            summary=redact_string(summary)[:1000],
            metadata=redact(metadata or {}),
            createdAt=now(),
        )
    )


async def notify(conn: AsyncConnection, level: str, type_: str, title: str, body: str, entity: tuple[str, str] | None = None) -> None:
    await conn.execute(
        insert(db.notifications).values(
            id=new_id(), level=level, type=type_, title=title, body=redact_string(body)[:1000],
            entityType=entity[0] if entity else None, entityId=entity[1] if entity else None, createdAt=now(),
        )
    )


async def load_source(conn: AsyncConnection, source_id: str) -> tuple[SourceRecord, dict[str, Any]] | None:
    s = db.sources
    c = db.source_configs
    row = (
        await conn.execute(
            select(s, c.c.allowedMediaTypes, c.c.maxItemsPerInterval, c.c.adapterOptions).select_from(s.outerjoin(c, c.c.sourceId == s.c.id)).where(s.c.id == source_id)
        )
    ).mappings().first()
    if row is None:
        return None
    rec = SourceRecord(
        id=str(row["id"]),
        name=row["name"],
        platform=row["platform"],
        url=row["url"],
        rights_status=row["rightsStatus"],
        attribution_text=row["attributionText"],
        allowed_media_types=tuple(row["allowedMediaTypes"] or ("VIDEO",)),
        max_items=int(row["maxItemsPerInterval"] or 5),
        adapter_options=dict(row["adapterOptions"] or {}),
    )
    return rec, dict(row)


class SourceNotImportable(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


def assert_importable(row: dict[str, Any]) -> None:
    """Mirror of SourcesService.assertImportable (TS). Checked again here so a
    stale job can never import from a source that was rejected meanwhile."""
    if row.get("deletedAt"):
        raise SourceNotImportable("SOURCE_NOT_APPROVED", "Source was deleted")
    if row.get("vettingStatus") != "APPROVED":
        raise SourceNotImportable("SOURCE_NOT_APPROVED", "The owner has not approved this source")
    if row.get("rightsStatus") == "DO_NOT_IMPORT":
        raise SourceNotImportable("RIGHTS_NOT_CONFIRMED", "Source is marked 'do not import'")
    if not row.get("active"):
        raise SourceNotImportable("SOURCE_NOT_APPROVED", "Source is inactive")


class JobRecord:
    """Writes a processing_jobs row so ingestion stages are visible in the Logs UI."""

    def __init__(self, conn_factory, queue: str, job_id: str, *, source_id: str | None, network_mode: str, host: str | None, input_: dict[str, Any]) -> None:
        self._conn_factory = conn_factory
        self.queue = queue
        self.job_id = job_id
        self.id = new_id()
        self.source_id = source_id
        self.network_mode = network_mode
        self.host = host
        self.input = input_
        self.started = now()

    async def start(self, retry_count: int) -> None:
        async with self._conn_factory() as conn:
            await conn.execute(
                insert(db.processing_jobs).values(
                    id=self.id, queue=self.queue, bullJobId=self.job_id, sourceId=self.source_id, status="RUNNING",
                    retryCount=retry_count, networkMode=self.network_mode, host=self.host, input=redact(self.input),
                    output={}, startedAt=self.started, createdAt=self.started,
                )
            )

    async def finish(self, status: str, *, content_id: str | None = None, output: dict[str, Any] | None = None, error_code: str | None = None, error: str | None = None, proxy_status: str | None = None) -> None:
        end = now()
        async with self._conn_factory() as conn:
            await conn.execute(
                update(db.processing_jobs)
                .where(db.processing_jobs.c.id == self.id)
                .values(
                    status=status, contentId=content_id, output=redact(output or {}), errorCode=error_code,
                    errorMessage=redact_string(error)[:2000] if error else None, proxyStatus=proxy_status,
                    finishedAt=end, durationMs=int((end - self.started).total_seconds() * 1000),
                )
            )
