"""Discovery and ingestion jobs.

  Source → Adapter → NetworkClient → temp file → checksum → metadata →
  duplicate detection → storage/originals → contents row → event for processing
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import structlog
from redis.asyncio import Redis
from sqlalchemy import insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncConnection

from reelflow_network import (
    NetworkMode,
    NetworkUnavailableError,
    ProxyManager,
    SourceUnavailableError,
    UrlBlockedError,
    client_for,
    normalize_url,
)
from reelflow_network.client import MediaTooLargeError

from . import db
from .adapters import AdapterRegistry, DiscoveredItem, SourceInvalid, UnsupportedSourceOperation
from .dedupe import DuplicateMatch, find_by_content, find_by_identity
from .fingerprint import image_dhash, video_fingerprint
from .media import MediaInvalidError, probe, sha256_file, sniff_file
from .queues import STREAMS, enqueue_python_job, jid
from .repo import JobRecord, SourceNotImportable, assert_importable, audit, load_source, new_id, notify, now

log = structlog.get_logger("pipeline")

RETRYABLE = (NetworkUnavailableError, SourceUnavailableError)
ConnFactory = Callable[[], AbstractAsyncContextManager[AsyncConnection]]


class RetryableError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass
class Deps:
    begin: ConnFactory
    redis: Redis
    registry: AdapterRegistry
    storage: Path
    upload_max_bytes: int
    network_mode: NetworkMode
    proxy: ProxyManager | None


def _key(storage: Path, key: str) -> Path:
    p = (storage / key).resolve()
    if not p.is_relative_to(storage.resolve()):
        raise MediaInvalidError("Storage key escapes storage root")
    return p


def _month_key(area: str, name: str) -> str:
    d = datetime.now(UTC)
    return f"{area}/{d:%Y}/{d:%m}/{name}"


# ── Discovery ─────────────────────────────────────────────────────────────
async def run_discovery(deps: Deps, data: dict[str, Any], job_id: str, attempt: int) -> dict[str, Any]:
    source_id = data["sourceId"]
    async with deps.begin() as conn:
        loaded = await load_source(conn, source_id)
    if not loaded:
        return {"skipped": True, "reason": "source not found"}
    source, row = loaded
    rec = JobRecord(deps.begin, "content-discovery", job_id, source_id=source_id, network_mode=deps.network_mode.value, host=_host(source.url), input_=data)
    await rec.start(attempt - 1)
    try:
        assert_importable(row)
        adapter = deps.registry.get(source.platform)
        await adapter.validate_source(source)
        async with client_for(deps.network_mode, deps.proxy, job_id=job_id) as client:
            items = await adapter.discover_content(source, client, source.max_items)
        created = 0
        async with deps.begin() as conn:
            for item in items:
                if item.media_type_hint and item.media_type_hint not in source.allowed_media_types:
                    continue
                req_id = new_id()
                stmt = (
                    pg_insert(db.ingestion_requests)
                    .values(
                        id=req_id, kind="DISCOVERED", sourceId=source.id, url=item.url,
                        normalizedUrl=normalize_url(item.url) if item.url and item.url.startswith("http") else None,
                        externalId=item.external_id, metadata=item.to_metadata(), status="QUEUED",
                        networkMode=deps.network_mode.value, attempts=0, createdAt=now(), updatedAt=now(),
                    )
                    .on_conflict_do_nothing(index_elements=["sourceId", "externalId"])
                    .returning(db.ingestion_requests.c.id)
                )
                if (await conn.execute(stmt)).first():
                    created += 1
                    await enqueue_python_job(deps.redis, "media-download", {"ingestionRequestId": req_id}, jid("download", req_id))
            await conn.execute(update(db.sources).where(db.sources.c.id == source.id).values(lastDiscoveryAt=now(), lastErrorCode=None, lastError=None, updatedAt=now()))
            await audit(conn, "discovery_finished", f'Discovered {len(items)} item(s), {created} new, from "{source.name}"', ("source", source.id), {"jobId": job_id})
        await rec.finish("SUCCEEDED", output={"found": len(items), "new": created})
        return {"found": len(items), "new": created}
    except (SourceNotImportable, UnsupportedSourceOperation, SourceInvalid, UrlBlockedError) as e:
        code = getattr(e, "code", "SOURCE_UNAVAILABLE")
        msg = e.reason if isinstance(e, UnsupportedSourceOperation) else str(e)
        async with deps.begin() as conn:
            await conn.execute(update(db.sources).where(db.sources.c.id == source_id).values(lastErrorCode=code, lastError=msg[:1000], lastDiscoveryAt=now(), updatedAt=now()))
            await notify(conn, "WARNING", "source_failed", f'Source "{source.name}" cannot be imported', msg, ("source", source_id))
        await rec.finish("FAILED", error_code=code, error=msg)
        return {"failed": True, "code": code}
    except RETRYABLE as e:
        await rec.finish("FAILED", error_code=e.code, error=str(e), proxy_status=_proxy_status(deps))
        raise RetryableError(e.code, str(e)) from e


# ── Ingestion ─────────────────────────────────────────────────────────────
async def run_ingest(deps: Deps, data: dict[str, Any], job_id: str, attempt: int) -> dict[str, Any]:
    req_id = data["ingestionRequestId"]
    r = db.ingestion_requests
    async with deps.begin() as conn:
        req = (await conn.execute(select(r).where(r.c.id == req_id))).mappings().first()
    if req is None:
        return {"skipped": True, "reason": "request not found"}
    if req["outcome"] is not None:
        return {"skipped": True, "reason": f"already {req['outcome']}"}  # idempotent re-delivery

    meta: dict[str, Any] = dict(req["metadata"] or {})
    source = None
    if req["sourceId"]:
        async with deps.begin() as conn:
            loaded = await load_source(conn, str(req["sourceId"]))
        if loaded:
            source, srow = loaded
            try:
                assert_importable(srow)
            except SourceNotImportable as e:
                await _finish_request(deps, req_id, "REJECTED", error_code=e.code, error=str(e))
                return {"rejected": e.code}

    host = _host(req["url"] or meta.get("mediaUrl"))
    rec = JobRecord(deps.begin, "media-download", job_id, source_id=str(req["sourceId"]) if req["sourceId"] else None, network_mode=deps.network_mode.value, host=host, input_=data)
    await rec.start(attempt - 1)
    async with deps.begin() as conn:
        await conn.execute(update(r).where(r.c.id == req_id).values(status="RUNNING", attempts=r.c.attempts + 1, networkMode=deps.network_mode.value, updatedAt=now()))

    # Layers 1–2 before any download.
    async with deps.begin() as conn:
        dup = await find_by_identity(conn, normalized_url=req["normalizedUrl"], source_id=str(req["sourceId"]) if req["sourceId"] else None, external_id=req["externalId"])
    if dup:
        await _record_duplicate(deps, req_id, dup)
        await rec.finish("SUCCEEDED", output={"duplicate": dup.layer, "of": dup.content_id})
        return {"duplicate": dup.layer}

    tmp = _key(deps.storage, f"incoming/{req_id}.part")
    tmp.parent.mkdir(parents=True, exist_ok=True)
    try:
        await _acquire(deps, req, meta, source, tmp, job_id)
        result = await _ingest_file(deps, req, meta, source, tmp)
        await rec.finish("SUCCEEDED", content_id=result.get("contentId"), output=result, proxy_status=_proxy_status(deps))
        return result
    except RETRYABLE as e:
        tmp.unlink(missing_ok=True)
        async with deps.begin() as conn:
            await conn.execute(update(r).where(r.c.id == req_id).values(status="QUEUED", errorCode=e.code, errorMessage=str(e)[:1000], updatedAt=now()))
        await rec.finish("FAILED", error_code=e.code, error=str(e), proxy_status=_proxy_status(deps))
        raise RetryableError(e.code, str(e)) from e
    except (MediaInvalidError, MediaTooLargeError, UnsupportedSourceOperation, SourceInvalid, UrlBlockedError) as e:
        code = getattr(e, "code", "MEDIA_INVALID")
        msg = e.reason if isinstance(e, UnsupportedSourceOperation) else str(e)
        _quarantine(deps, tmp, req_id)
        await _finish_request(deps, req_id, "REJECTED", error_code=code, error=msg)
        await rec.finish("FAILED", error_code=code, error=msg)
        return {"rejected": code}
    except Exception as e:  # unexpected: record, keep the file for inspection, let the stream retry
        _quarantine(deps, tmp, req_id)
        await rec.finish("FAILED", error_code="INTERNAL_ERROR", error=str(e))
        raise


async def _acquire(deps: Deps, req: dict[str, Any], meta: dict[str, Any], source, tmp: Path, job_id: str) -> None:
    kind = req["kind"]
    if kind == "LOCAL_FILE":
        key = req["localKey"] or ""
        if not (key.startswith("incoming/") or key.startswith("inbox/")):
            raise MediaInvalidError("Local file must be in storage/incoming or storage/inbox")
        shutil.move(_key(deps.storage, key), tmp)
        return
    async with client_for(deps.network_mode, deps.proxy, job_id=job_id) as client:
        if kind == "DIRECT_URL":
            item = DiscoveredItem(external_id=req["id"], url=req["url"], media_url=req["url"])
            await deps.registry.direct.download_authorized_media(None, item, client, tmp, deps.upload_max_bytes)
            return
        if source is None:
            raise SourceInvalid("Discovered item has no source")
        item = DiscoveredItem.from_metadata(meta)
        adapter = deps.registry.get(source.platform)
        item = await adapter.fetch_metadata(source, item, client)
        await adapter.download_authorized_media(source, item, client, tmp, deps.upload_max_bytes)


async def _ingest_file(deps: Deps, req: dict[str, Any], meta: dict[str, Any], source, tmp: Path) -> dict[str, Any]:
    sniffed = sniff_file(tmp)
    if sniffed is None:
        raise MediaInvalidError("Not a supported video or image file")
    if source and sniffed.media_type not in source.allowed_media_types:
        raise MediaInvalidError(f"{sniffed.media_type} is not allowed for this source")
    checksum = sha256_file(tmp)
    info = await probe(tmp, sniffed)
    phash = image_dhash(tmp) if sniffed.media_type == "IMAGE" else None
    vfp = await video_fingerprint(tmp, info.duration) if sniffed.media_type == "VIDEO" else []

    async with deps.begin() as conn:
        dup = await find_by_content(conn, checksum=checksum, media_type=sniffed.media_type, phash=phash, video_fp=vfp, duration=info.duration)
    if dup:
        tmp.unlink(missing_ok=True)  # do not keep a second copy
        await _record_duplicate(deps, req["id"], dup)
        return {"duplicate": dup.layer, "of": dup.content_id}

    item = DiscoveredItem.from_metadata(meta) if meta.get("externalId") else None
    adapter = deps.registry.get(source.platform) if source else None
    norm = adapter.normalize_metadata(item) if adapter and item else None
    rights = meta.get("rightsStatus") or (source.rights_status if source else "UNKNOWN")
    content_id = new_id()
    original_key = _month_key("originals", f"{content_id}{sniffed.ext}")
    dest = _key(deps.storage, original_key)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp.replace(dest)
    try:
        async with deps.begin() as conn:
            await conn.execute(
                insert(db.contents).values(
                    id=content_id,
                    sourceId=str(req["sourceId"]) if req["sourceId"] else None,
                    ingestionRequestId=req["id"],
                    originalUrl=(norm.original_url if norm else None) or req["url"],
                    normalizedUrl=req["normalizedUrl"],
                    externalId=req["externalId"] if req["kind"] == "DISCOVERED" else None,
                    platform=source.platform if source else ("DIRECT_URL" if req["kind"] == "DIRECT_URL" else "LOCAL"),
                    author=norm.author if norm else None,
                    originalCaption=(norm.caption if norm else None) or meta.get("caption"),
                    mediaType=sniffed.media_type,
                    kind="REEL" if sniffed.media_type == "VIDEO" else "FEED",
                    durationSec=info.duration,
                    width=info.width,
                    height=info.height,
                    fps=info.fps,
                    videoCodec=info.video_codec,
                    audioCodec=info.audio_codec,
                    fileSize=dest.stat().st_size,
                    checksum=checksum,
                    perceptualHash=phash,
                    videoFingerprint=vfp or None,
                    originalCreatedAt=norm.created_at.replace(tzinfo=None) if norm and norm.created_at else None,
                    importedAt=now(),
                    processingStatus="PENDING",
                    rightsStatus=rights,
                    approvalStatus="PENDING",
                    originalKey=original_key,
                    hashtags=norm.hashtags if norm else [],
                    attribution=meta.get("attribution") or (source.attribution_text if source else None),
                    createdAt=now(),
                    updatedAt=now(),
                )
            )
            await conn.execute(
                update(db.ingestion_requests).where(db.ingestion_requests.c.id == req["id"]).values(status="SUCCEEDED", outcome="IMPORTED", contentId=content_id, errorCode=None, errorMessage=None, updatedAt=now())
            )
            await audit(conn, "content_imported", f"Imported {sniffed.media_type.lower()} ({info.width}x{info.height})", ("content", content_id), {"checksum": checksum, "rights": rights})
            await conn.execute(insert(db.analytics_events).values(id=new_id(), type="content_imported", contentId=content_id, sourceId=str(req["sourceId"]) if req["sourceId"] else None, value=1, metadata={}, occurredAt=now()))
    except IntegrityError:
        # Lost a race with a concurrent import of the same file: treat as duplicate.
        dest.unlink(missing_ok=True)
        async with deps.begin() as conn:
            row = (await conn.execute(select(db.contents.c.id).where(db.contents.c.checksum == checksum))).first()
        if row:
            await _record_duplicate(deps, req["id"], DuplicateMatch("checksum", str(row.id)))
            return {"duplicate": "checksum", "of": str(row.id)}
        raise
    await deps.redis.xadd(STREAMS["events"], {"event": json.dumps({"type": "content_ingested", "contentId": content_id, "ingestionRequestId": req["id"]})}, maxlen=10000, approximate=True)
    return {"contentId": content_id, "mediaType": sniffed.media_type}


async def _record_duplicate(deps: Deps, req_id: str, dup: DuplicateMatch) -> None:
    async with deps.begin() as conn:
        await conn.execute(
            update(db.ingestion_requests).where(db.ingestion_requests.c.id == req_id).values(status="SUCCEEDED", outcome="DUPLICATE", duplicateOfId=dup.content_id, errorCode="DUPLICATE_CONTENT", errorMessage=f"Duplicate ({dup.layer}) of {dup.content_id}", updatedAt=now())
        )
        await audit(conn, "content_duplicate", f"Duplicate detected by {dup.layer} — linked to the original, no copy stored", ("content", dup.content_id), {"ingestionRequestId": req_id, "distance": dup.distance})


async def _finish_request(deps: Deps, req_id: str, outcome: str, *, error_code: str, error: str) -> None:
    async with deps.begin() as conn:
        await conn.execute(update(db.ingestion_requests).where(db.ingestion_requests.c.id == req_id).values(status="FAILED", outcome=outcome, errorCode=error_code, errorMessage=error[:1000], updatedAt=now()))
        await audit(conn, "ingest_rejected", f"Ingestion {outcome.lower()}: {error[:200]}", ("ingestion", req_id), {"code": error_code})


def _quarantine(deps: Deps, tmp: Path, req_id: str) -> None:
    if tmp.exists():
        failed = _key(deps.storage, _month_key("failed", f"{req_id}.bin"))
        failed.parent.mkdir(parents=True, exist_ok=True)
        tmp.replace(failed)


def _host(url: str | None) -> str | None:
    from urllib.parse import urlsplit

    return urlsplit(url).hostname if url and url.startswith("http") else None


def _proxy_status(deps: Deps) -> str | None:
    if deps.network_mode is NetworkMode.DIRECT or deps.proxy is None or deps.proxy._last is None:  # noqa: SLF001
        return None
    return deps.proxy._last.status.value  # noqa: SLF001
