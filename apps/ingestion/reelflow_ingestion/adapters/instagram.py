"""Instagram pages as a *source*, read through a logged-in session.

For pages that allow re-posting their content (the owner still has to approve
the source and set its rights status). Discovery lists the page's latest posts
via the reader account (Accounts → Instagram login); download fetches the video
or photo from Instagram's CDN through the normal NetworkClient (proxy mode fails
closed). Duplicates are skipped by (source, post id) before anything is fetched.

adapterOptions:
  readerAccountId  publishing account used to read this page (default: the
                   oldest connected Instagram login account)
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

from reelflow_network import NetworkClient, SourceUnavailableError

from .base import ContentSourceAdapter, DiscoveredItem, SourceInvalid, SourceRecord, UnsupportedSourceOperation

if TYPE_CHECKING:
    from ..instagram_session import InstagramSessions, MediaSummary

HOSTS = {"instagram.com", "www.instagram.com", "m.instagram.com"}
RESERVED = {"p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct"}
USERNAME = re.compile(r"^[A-Za-z0-9._]{1,30}$")
NO_SESSION = (
    "Reading Instagram pages needs a logged-in Instagram account. Connect one under Accounts "
    "(Instagram login); it is used to read the source pages."
)


def username_from_url(url: str | None) -> str:
    parts = urlsplit(url or "")
    if (parts.hostname or "").lower() not in HOSTS:
        raise SourceInvalid("Instagram sources must be instagram.com profile URLs")
    segs = [s for s in parts.path.split("/") if s]
    if not segs or segs[0].lower() in RESERVED or not USERNAME.match(segs[0]):
        raise SourceInvalid("Use the page's profile URL, e.g. https://www.instagram.com/pagename/")
    return segs[0].lower()


def _item(m: "MediaSummary") -> DiscoveredItem:
    return DiscoveredItem(
        external_id=f"ig:{m.pk}",
        url=m.permalink,
        media_url=m.media_url,
        caption=m.caption,
        author=m.author,
        created_at=m.taken_at,
        media_type_hint=m.media_type,
    )


class InstagramAdapter(ContentSourceAdapter):
    platform = "INSTAGRAM"

    def __init__(self, sessions: "InstagramSessions | None" = None) -> None:
        self.sessions = sessions

    def _sessions(self) -> "InstagramSessions":
        if self.sessions is None:
            raise UnsupportedSourceOperation("instagram_session", NO_SESSION)
        return self.sessions

    async def _reader(self, source: SourceRecord) -> str:
        from ..instagram_session import SessionError

        try:
            return await self._sessions().reader_account_id(source.adapter_options.get("readerAccountId"))
        except SessionError as e:
            raise UnsupportedSourceOperation("instagram_session", str(e)) from e

    async def validate_source(self, source: SourceRecord) -> None:
        username_from_url(source.url)

    async def discover_content(self, source: SourceRecord, client: NetworkClient, limit: int) -> list[DiscoveredItem]:
        from ..instagram_session import SessionError

        username = username_from_url(source.url)
        reader = await self._reader(source)
        try:
            medias = await self._sessions().recent_media(reader, username, limit)
        except SessionError as e:
            raise _translate(e) from e
        # Oldest first, so posts are imported (and later scheduled) in the page's order.
        return [_item(m) for m in sorted(medias, key=lambda m: m.taken_at.timestamp() if m.taken_at else 0) if m.media_url]

    async def fetch_metadata(self, source: SourceRecord, item: DiscoveredItem, client: NetworkClient) -> DiscoveredItem:
        """CDN links expire after a few hours, so the link is refreshed right before download."""
        from ..instagram_session import SessionError

        pk = item.external_id.removeprefix("ig:")
        try:
            fresh = await self._sessions().media(await self._reader(source), pk)
        except SessionError as e:
            # An expired login must not reject the item for good: retry once reconnected.
            raise _translate(e, retry_auth=True) from e
        if not fresh.media_url:
            raise SourceInvalid("This post has no downloadable media")
        item.media_url = fresh.media_url
        item.media_type_hint = fresh.media_type
        return item

    async def download_authorized_media(self, source: SourceRecord, item: DiscoveredItem, client: NetworkClient, dest: Path, max_bytes: int) -> Path:
        if not item.media_url:
            raise SourceInvalid("No media URL for this post")
        await client.download(item.media_url, dest, max_bytes=max_bytes)
        return dest


def _translate(e: Exception, *, retry_auth: bool = False) -> Exception:
    from reelflow_network import NetworkUnavailableError

    code = getattr(e, "code", "")
    if code == "NETWORK_UNAVAILABLE":
        return NetworkUnavailableError(str(e))
    if code in {"RATE_LIMITED", "PUBLISH_FAILED"} or (retry_auth and code == "AUTH_EXPIRED"):
        return SourceUnavailableError(str(e))  # retried with backoff
    if code == "SOURCE_UNAVAILABLE":
        return SourceInvalid(str(e))
    return UnsupportedSourceOperation("instagram_session", str(e))
