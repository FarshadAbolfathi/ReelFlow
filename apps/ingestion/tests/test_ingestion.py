from __future__ import annotations

import json
import subprocess
from pathlib import Path

import httpx
import pytest
from PIL import Image
from sqlalchemy import select, text

from reelflow_ingestion import db
from reelflow_ingestion.adapters import GenericFeedAdapter, SourceRecord, UnsupportedSourceOperation
from reelflow_ingestion.adapters.direct_url import DirectUrlAdapter
from reelflow_ingestion.adapters.base import DiscoveredItem
from reelflow_ingestion.pipeline import RetryableError, run_discovery, run_ingest
from reelflow_ingestion.queues import STREAMS
from reelflow_ingestion.streams import StreamConsumer, move_due_retries
from reelflow_network import NetworkClient, NetworkMode, ProxyConfig, ProxyManager

from .conftest import insert_source, insert_upload, make_video


async def request_row(deps, rid: str):
    async with deps.begin() as conn:
        return (await conn.execute(select(db.ingestion_requests).where(db.ingestion_requests.c.id == rid))).mappings().one()


async def content_count(deps) -> int:
    async with deps.begin() as conn:
        return (await conn.execute(text("SELECT count(*) FROM contents"))).scalar_one()


async def test_db_contract_columns_exist(deps):
    """Every column mapped in SQLAlchemy exists in the Prisma-managed schema."""
    async with deps.begin() as conn:
        for table in db.metadata.sorted_tables:
            rows = await conn.execute(text("SELECT column_name FROM information_schema.columns WHERE table_name = :t"), {"t": table.name})
            actual = {r[0] for r in rows}
            missing = {c.name for c in table.columns} - actual
            assert not missing, f"{table.name} is missing {missing}"


async def test_upload_is_ingested_stored_and_announced(deps, tmp_path: Path):
    rid = await insert_upload(deps, make_video(tmp_path / "a.mp4"))
    result = await run_ingest(deps, {"ingestionRequestId": rid}, f"download.{rid}", 1)
    assert "contentId" in result
    req = await request_row(deps, rid)
    assert (req["status"], req["outcome"]) == ("SUCCEEDED", "IMPORTED")
    async with deps.begin() as conn:
        c = (await conn.execute(select(db.contents).where(db.contents.c.id == result["contentId"]))).mappings().one()
    assert c["mediaType"] == "VIDEO" and c["width"] == 640 and c["processingStatus"] == "PENDING"
    assert c["rightsStatus"] == "USER_OWNS" and c["checksum"] and len(c["videoFingerprint"]) == 5
    assert (deps.storage / c["originalKey"]).is_file()
    assert not (deps.storage / f"incoming/{rid}.bin").exists()
    events = await deps.redis.xrange(STREAMS["events"])
    assert json.loads(events[-1][1][b"event"])["contentId"] == result["contentId"]


async def test_rerun_is_idempotent(deps, tmp_path: Path):
    rid = await insert_upload(deps, make_video(tmp_path / "a.mp4"))
    await run_ingest(deps, {"ingestionRequestId": rid}, "j", 1)
    again = await run_ingest(deps, {"ingestionRequestId": rid}, "j", 2)
    assert again["skipped"] is True
    assert await content_count(deps) == 1


async def test_same_file_twice_is_duplicate_by_checksum_and_not_stored(deps, tmp_path: Path):
    video = make_video(tmp_path / "a.mp4")
    first = await run_ingest(deps, {"ingestionRequestId": await insert_upload(deps, video)}, "j1", 1)
    rid2 = await insert_upload(deps, video)
    second = await run_ingest(deps, {"ingestionRequestId": rid2}, "j2", 1)
    assert second == {"duplicate": "checksum", "of": first["contentId"]}
    req = await request_row(deps, rid2)
    assert req["outcome"] == "DUPLICATE" and str(req["duplicateOfId"]) == first["contentId"]
    assert await content_count(deps) == 1
    originals = list((deps.storage / "originals").rglob("*.mp4"))
    assert len(originals) == 1


async def test_reencoded_video_is_duplicate_by_fingerprint(deps, tmp_path: Path):
    await run_ingest(deps, {"ingestionRequestId": await insert_upload(deps, make_video(tmp_path / "a.mp4"))}, "j1", 1)
    other = make_video(tmp_path / "b.mp4", size="480x270", bitrate="300k")  # same frames, different encode/size
    r = await run_ingest(deps, {"ingestionRequestId": await insert_upload(deps, other)}, "j2", 1)
    assert r.get("duplicate") == "video_fingerprint"


async def test_different_video_is_not_a_duplicate(deps, tmp_path: Path):
    await run_ingest(deps, {"ingestionRequestId": await insert_upload(deps, make_video(tmp_path / "a.mp4"))}, "j1", 1)
    r = await run_ingest(deps, {"ingestionRequestId": await insert_upload(deps, make_video(tmp_path / "c.mp4", color_src="mandelbrot"))}, "j2", 1)
    assert "contentId" in r


async def test_resized_image_is_duplicate_by_perceptual_hash(deps, tmp_path: Path):
    img = Image.effect_mandelbrot((800, 600), (-2, -1.2, 1, 1.2), 100).convert("RGB")
    img.save(tmp_path / "a.jpg", quality=95)
    img.resize((400, 300)).save(tmp_path / "b.jpg", quality=70)
    await run_ingest(deps, {"ingestionRequestId": await insert_upload(deps, tmp_path / "a.jpg")}, "j1", 1)
    r = await run_ingest(deps, {"ingestionRequestId": await insert_upload(deps, tmp_path / "b.jpg")}, "j2", 1)
    assert r.get("duplicate") == "phash"


async def test_non_media_is_rejected_and_quarantined(deps, tmp_path: Path):
    evil = tmp_path / "evil.mp4"
    evil.write_text("#!/bin/sh\nrm -rf /\n")
    rid = await insert_upload(deps, evil)
    r = await run_ingest(deps, {"ingestionRequestId": rid}, "j", 1)
    assert r == {"rejected": "MEDIA_INVALID"}
    assert list((deps.storage / "failed").rglob(f"{rid}.bin"))


async def test_unapproved_source_is_never_imported(deps, tmp_path: Path):
    sid = await insert_source(deps, vetting="PENDING_REVIEW")
    rid = await insert_upload(deps, make_video(tmp_path / "a.mp4"), source_id=sid)
    assert await run_ingest(deps, {"ingestionRequestId": rid}, "j", 1) == {"rejected": "SOURCE_NOT_APPROVED"}
    assert await content_count(deps) == 0
    r = await run_discovery(deps, {"sourceId": sid}, "d", 1)
    assert r == {"failed": True, "code": "SOURCE_NOT_APPROVED"}


async def test_inbox_discovery_then_ingest(deps, tmp_path: Path):
    sid = await insert_source(deps, platform="LOCAL", name="Funny Page")
    inbox = deps.storage / "inbox" / "funny-page"
    inbox.mkdir(parents=True)
    make_video(inbox / "clip1.mp4")
    (inbox / "clip1.txt").write_text("Caption from the page owner #funny")
    r = await run_discovery(deps, {"sourceId": sid}, "d1", 1)
    assert r == {"found": 1, "new": 1}
    msgs = await deps.redis.xrange(STREAMS["media-download"])
    rid = json.loads(msgs[-1][1][b"data"])["ingestionRequestId"]
    res = await run_ingest(deps, {"ingestionRequestId": rid}, "j", 1)
    async with deps.begin() as conn:
        c = (await conn.execute(select(db.contents).where(db.contents.c.id == res["contentId"]))).mappings().one()
    assert c["originalCaption"].startswith("Caption from the page owner")
    assert c["hashtags"] == ["funny"] and c["attribution"] == "🎬 via Funny Page"
    assert c["rightsStatus"] == "PERMISSION_GRANTED"
    assert (inbox / ".imported" / "clip1.mp4").is_file()
    # Re-running discovery finds nothing new.
    assert (await run_discovery(deps, {"sourceId": sid}, "d2", 1)) == {"found": 0, "new": 0}


async def test_instagram_source_needs_a_logged_in_account(deps):
    sid = await insert_source(deps, platform="INSTAGRAM", url="https://www.instagram.com/somepage/")
    r = await run_discovery(deps, {"sourceId": sid}, "d", 1)
    assert r == {"failed": True, "code": "UNSUPPORTED_SOURCE_OPERATION"}
    async with deps.begin() as conn:
        s = (await conn.execute(select(db.sources).where(db.sources.c.id == sid))).mappings().one()
        n = (await conn.execute(text("SELECT count(*) FROM notifications WHERE type = 'source_failed'"))).scalar_one()
    assert s["lastErrorCode"] == "UNSUPPORTED_SOURCE_OPERATION" and "logged-in Instagram account" in s["lastError"]
    assert n == 1


async def test_direct_download_refuses_platforms_that_forbid_it():
    adapter = DirectUrlAdapter(frozenset({"instagram", "example"}))
    async with NetworkClient(NetworkMode.DIRECT) as client:
        for url in ("https://www.instagram.com/reel/ABC/", "https://www.tiktok.com/@x/video/1", "https://m.facebook.com/watch/?v=1"):
            with pytest.raises(UnsupportedSourceOperation):
                await adapter.download_authorized_media(None, DiscoveredItem(external_id="x", url=url, media_url=url), client, Path("/tmp/x"), 1000)
    assert "instagram" not in adapter.ytdlp_allowed


async def test_generic_feed_parsing():
    rss = b"""<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/"><channel><title>T</title>
      <item><guid>a1</guid><title>Clip one #lol</title><link>https://example.com/a1</link><enclosure url="https://cdn.example.com/a1.mp4" type="video/mp4" length="1"/></item>
      <item><guid>a2</guid><title>No media</title><link>https://example.com/a2</link></item>
      <item><guid>a3</guid><title>Photo</title><media:content url="https://cdn.example.com/a3.jpg" medium="image"/></item>
    </channel></rss>"""
    transport = httpx.MockTransport(lambda req: httpx.Response(200, content=rss))
    src = SourceRecord("s", "Feed", "GENERIC_FEED", "https://example.com/feed.xml", "LICENSED", None, ("VIDEO", "IMAGE"), 10, {})
    async with NetworkClient(NetworkMode.DIRECT, ssrf_protection=False, transport=transport) as client:
        items = await GenericFeedAdapter().discover_content(src, client, 10)
    assert [(i.external_id, i.media_type_hint) for i in items] == [("a1", "VIDEO"), ("a3", "IMAGE")]
    assert GenericFeedAdapter().normalize_metadata(items[0]).hashtags == ["lol"]


async def test_proxy_mode_fails_closed_for_downloads(deps, tmp_path: Path):
    target_hits: list[str] = []
    cfg = ProxyConfig(mode=NetworkMode.PROXY, port=1, health_timeout_s=1)  # nothing listens on port 1
    deps.runtime.mode = NetworkMode.PROXY
    deps.runtime.manager = ProxyManager(cfg)
    rid = "00000000-0000-4000-8000-000000000001"
    async with deps.begin() as conn:
        await conn.execute(
            text("INSERT INTO ingestion_requests (id, kind, url, metadata, status, \"networkMode\", attempts, \"createdAt\", \"updatedAt\") VALUES (:id, 'DIRECT_URL', 'https://example.com/v.mp4', '{}', 'QUEUED', 'PROXY', 0, now(), now())"),
            {"id": rid},
        )
    with pytest.raises(RetryableError) as e:
        await run_ingest(deps, {"ingestionRequestId": rid}, "j", 1)
    assert e.value.code == "NETWORK_UNAVAILABLE"
    req = await request_row(deps, rid)
    assert req["status"] == "QUEUED" and req["errorCode"] == "NETWORK_UNAVAILABLE"
    assert target_hits == []
    async with deps.begin() as conn:
        job = (await conn.execute(select(db.processing_jobs).where(db.processing_jobs.c.bullJobId == "j"))).mappings().one()
    assert job["networkMode"] == "PROXY" and job["status"] == "FAILED" and job["proxyStatus"] == "UNAVAILABLE"


async def test_stream_retry_with_backoff(deps):
    calls: list[int] = []

    async def flaky(data, job_id, attempt):
        calls.append(attempt)
        if attempt == 1:
            raise RetryableError("NETWORK_UNAVAILABLE", "proxy down")
        return {"ok": True}

    consumer = StreamConsumer(deps.redis, "media-download", flaky, "test-consumer")
    await deps.redis.xadd(STREAMS["media-download"], {"jobId": "download.x", "data": "{}", "attempt": "1"})
    import asyncio

    task = asyncio.create_task(consumer.run())
    for _ in range(50):
        if calls:
            break
        await asyncio.sleep(0.1)
    # Pretend the backoff elapsed.
    entries = await deps.redis.zrange(STREAMS["retry"], 0, -1)
    assert len(entries) == 1
    await deps.redis.zadd(STREAMS["retry"], {entries[0]: 0})
    assert await move_due_retries(deps.redis) == 1
    for _ in range(50):
        if len(calls) == 2:
            break
        await asyncio.sleep(0.1)
    consumer.stop()
    await asyncio.wait_for(task, 10)
    assert calls == [1, 2]
    pending = await deps.redis.xpending(STREAMS["media-download"], "reelflow-ingestion")
    assert pending["pending"] == 0


def test_ffmpeg_available():
    assert subprocess.run(["ffmpeg", "-version"], capture_output=True).returncode == 0
