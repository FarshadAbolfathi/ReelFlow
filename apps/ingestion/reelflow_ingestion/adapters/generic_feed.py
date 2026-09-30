"""RSS / Atom / JSON Feed sources with media enclosures — a public, standard,
publisher-controlled way to syndicate content."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from time import struct_time

import feedparser

from reelflow_network import NetworkClient, validate_public_url

from .base import ContentSourceAdapter, DiscoveredItem, SourceInvalid, SourceRecord

MAX_FEED_BYTES = 5 * 1024 * 1024


def _ts(t: struct_time | None) -> datetime | None:
    return datetime(*t[:6], tzinfo=UTC) if t else None


def _media_type(mime: str | None) -> str | None:
    if not mime:
        return None
    return "VIDEO" if mime.startswith("video/") else "IMAGE" if mime.startswith("image/") else None


class GenericFeedAdapter(ContentSourceAdapter):
    platform = "GENERIC_FEED"

    async def validate_source(self, source: SourceRecord) -> None:
        if not source.url:
            raise SourceInvalid("Feed sources need a URL")
        validate_public_url(source.url)

    async def _fetch(self, url: str, client: NetworkClient) -> bytes:
        resp = await client.get(url)
        if resp.status_code != 200:
            raise SourceInvalid(f"Feed returned HTTP {resp.status_code}")
        if len(resp.content) > MAX_FEED_BYTES:
            raise SourceInvalid("Feed is too large")
        return resp.content

    async def discover_content(self, source: SourceRecord, client: NetworkClient, limit: int) -> list[DiscoveredItem]:
        await self.validate_source(source)
        body = await self._fetch(source.url or "", client)
        stripped = body.lstrip()
        items = self._parse_json_feed(stripped) if stripped[:1] == b"{" else self._parse_xml_feed(body)
        return items[:limit]

    def _parse_xml_feed(self, body: bytes) -> list[DiscoveredItem]:
        parsed = feedparser.parse(body)
        out: list[DiscoveredItem] = []
        for e in parsed.entries:
            media: tuple[str, str | None] | None = None
            for enc in e.get("enclosures", []):
                if _media_type(enc.get("type")):
                    media = (enc.get("href"), enc.get("type"))
                    break
            if not media:
                for mc in e.get("media_content", []):
                    mtype = mc.get("type") or ("video/mp4" if mc.get("medium") == "video" else "image/jpeg" if mc.get("medium") == "image" else None)
                    if _media_type(mtype) and mc.get("url"):
                        media = (mc["url"], mtype)
                        break
            if not media or not media[0]:
                continue
            ext_id = e.get("id") or e.get("link") or hashlib.sha256(media[0].encode()).hexdigest()
            out.append(
                DiscoveredItem(
                    external_id=str(ext_id)[:500],
                    url=e.get("link"),
                    media_url=media[0],
                    caption=e.get("title") or e.get("summary"),
                    author=e.get("author"),
                    created_at=_ts(e.get("published_parsed") or e.get("updated_parsed")),
                    media_type_hint=_media_type(media[1]),
                    hashtags=[t.get("term") for t in e.get("tags", []) if t.get("term")],
                )
            )
        return out

    def _parse_json_feed(self, body: bytes) -> list[DiscoveredItem]:
        data = json.loads(body)
        out: list[DiscoveredItem] = []
        for it in data.get("items", []):
            att = next((a for a in it.get("attachments", []) if _media_type(a.get("mime_type"))), None)
            media_url = att["url"] if att else it.get("image")
            if not media_url:
                continue
            published = it.get("date_published")
            out.append(
                DiscoveredItem(
                    external_id=str(it.get("id") or media_url)[:500],
                    url=it.get("url"),
                    media_url=media_url,
                    caption=it.get("title") or it.get("content_text"),
                    author=(it.get("authors") or [{}])[0].get("name"),
                    created_at=datetime.fromisoformat(published.replace("Z", "+00:00")) if published else None,
                    media_type_hint=_media_type(att.get("mime_type")) if att else "IMAGE",
                    hashtags=list(it.get("tags") or []),
                )
            )
        return out

    async def download_authorized_media(self, source: SourceRecord, item: DiscoveredItem, client: NetworkClient, dest: Path, max_bytes: int) -> Path:
        if not item.media_url:
            raise SourceInvalid("Feed item has no media")
        await client.download(item.media_url, dest, max_bytes=max_bytes)
        return dest
