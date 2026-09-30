"""Duplicate detection, cheapest layer first:
  1. normalized URL   2. (source, external id)   3. SHA-256   4. perceptual hash / video fingerprint
"""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncConnection

from . import db
from .fingerprint import IMAGE_THRESHOLD, VIDEO_THRESHOLD, hamming, video_distance


@dataclass(frozen=True)
class DuplicateMatch:
    layer: str  # url | external_id | checksum | phash | video_fingerprint
    content_id: str
    distance: float | None = None


async def find_by_identity(conn: AsyncConnection, *, normalized_url: str | None, source_id: str | None, external_id: str | None) -> DuplicateMatch | None:
    """Layers 1–2: cheap checks possible before downloading anything."""
    c = db.contents
    if normalized_url:
        row = (await conn.execute(select(c.c.id).where(and_(c.c.normalizedUrl == normalized_url, c.c.duplicateOfId.is_(None))).limit(1))).first()
        if row:
            return DuplicateMatch("url", str(row.id))
    if source_id and external_id:
        row = (await conn.execute(select(c.c.id).where(and_(c.c.sourceId == source_id, c.c.externalId == external_id)).limit(1))).first()
        if row:
            return DuplicateMatch("external_id", str(row.id))
    return None


async def find_by_content(
    conn: AsyncConnection,
    *,
    checksum: str,
    media_type: str,
    phash: str | None,
    video_fp: list[str],
    duration: float | None,
) -> DuplicateMatch | None:
    """Layers 3–4: after the file is on disk."""
    c = db.contents
    row = (await conn.execute(select(c.c.id).where(c.c.checksum == checksum).limit(1))).first()
    if row:
        return DuplicateMatch("checksum", str(row.id))

    if media_type == "IMAGE" and phash:
        rows = (await conn.execute(select(c.c.id, c.c.perceptualHash).where(and_(c.c.mediaType == "IMAGE", c.c.perceptualHash.isnot(None), c.c.duplicateOfId.is_(None))))).all()
        best = min(((hamming(phash, r.perceptualHash), str(r.id)) for r in rows), default=None)
        if best and best[0] <= IMAGE_THRESHOLD:
            return DuplicateMatch("phash", best[1], best[0])

    if media_type == "VIDEO" and len(video_fp) >= 3 and duration:
        # Candidates of similar length only — keeps the comparison cheap.
        rows = (
            await conn.execute(
                select(c.c.id, c.c.videoFingerprint).where(
                    and_(c.c.mediaType == "VIDEO", c.c.videoFingerprint.isnot(None), c.c.duplicateOfId.is_(None), c.c.durationSec.between(duration - 1.5, duration + 1.5))
                )
            )
        ).all()
        for r in rows:
            d = video_distance(video_fp, list(r.videoFingerprint or []))
            if d is not None and d <= VIDEO_THRESHOLD:
                return DuplicateMatch("video_fingerprint", str(r.id), d)
    return None
