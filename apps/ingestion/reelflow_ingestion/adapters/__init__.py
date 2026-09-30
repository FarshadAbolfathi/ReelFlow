from pathlib import Path

from .base import ContentSourceAdapter, DiscoveredItem, NormalizedMetadata, SourceInvalid, SourceRecord, UnsupportedSourceOperation
from .direct_url import DirectUrlAdapter
from .generic_feed import GenericFeedAdapter
from .instagram import InstagramAdapter
from .local_folder import LocalFolderAdapter


class AdapterRegistry:
    """Maps a source platform to its adapter. New platforms register here."""

    def __init__(self, inbox_root: Path, ytdlp_allowed: frozenset[str]) -> None:
        self._adapters: dict[str, ContentSourceAdapter] = {}
        for a in (GenericFeedAdapter(), LocalFolderAdapter(inbox_root), InstagramAdapter(), DirectUrlAdapter(ytdlp_allowed)):
            self.register(a)

    def register(self, adapter: ContentSourceAdapter) -> None:
        self._adapters[adapter.platform] = adapter

    def get(self, platform: str) -> ContentSourceAdapter:
        a = self._adapters.get(platform)
        if a is None:
            raise UnsupportedSourceOperation("adapter", f"No ingestion adapter for platform {platform} yet")
        return a

    @property
    def direct(self) -> DirectUrlAdapter:
        return self._adapters["DIRECT_URL"]  # type: ignore[return-value]


__all__ = [
    "AdapterRegistry",
    "ContentSourceAdapter",
    "DirectUrlAdapter",
    "DiscoveredItem",
    "GenericFeedAdapter",
    "InstagramAdapter",
    "LocalFolderAdapter",
    "NormalizedMetadata",
    "SourceInvalid",
    "SourceRecord",
    "UnsupportedSourceOperation",
]
