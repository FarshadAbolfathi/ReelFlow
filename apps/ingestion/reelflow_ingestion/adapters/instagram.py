"""Instagram as a *source*.

The official Instagram APIs let an app read media of accounts that authorised
it, and Business Discovery exposes limited public metadata of other
professional accounts. They do not provide a way to download other accounts'
media for re-posting, and Instagram's terms prohibit automated collection.

So this adapter stops at that boundary: discovery and download return
UNSUPPORTED_SOURCE_OPERATION with an explanation, and no scraping or
browser-automation workaround is implemented.

Supported alternative for pages that have given you permission:
  • ask the page owner for the original files and drop them in the source's
    inbox folder (storage/inbox/<source>/), or upload them in the UI;
  • or import a direct media link they share with you ("Import URL").

TODO(official): Business Discovery metadata lookup (captions/permalinks only)
for professional accounts, via the connected account's token.
"""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlsplit

from reelflow_network import NetworkClient

from .base import ContentSourceAdapter, DiscoveredItem, SourceInvalid, SourceRecord, UnsupportedSourceOperation

REASON = (
    "Instagram's official API does not allow downloading media from accounts you don't manage, "
    "and its terms forbid automated collection. Ask the page owner for the files and put them in "
    "this source's inbox folder, upload them, or import a direct link they share with you."
)


class InstagramAdapter(ContentSourceAdapter):
    platform = "INSTAGRAM"

    async def validate_source(self, source: SourceRecord) -> None:
        host = (urlsplit(source.url or "").hostname or "").lower()
        if host not in {"instagram.com", "www.instagram.com"}:
            raise SourceInvalid("Instagram sources must be instagram.com profile URLs")

    async def discover_content(self, source: SourceRecord, client: NetworkClient, limit: int) -> list[DiscoveredItem]:
        raise UnsupportedSourceOperation("discover_content", REASON)

    async def download_authorized_media(self, source: SourceRecord, item: DiscoveredItem, client: NetworkClient, dest: Path, max_bytes: int) -> Path:
        raise UnsupportedSourceOperation("download_authorized_media", REASON)
