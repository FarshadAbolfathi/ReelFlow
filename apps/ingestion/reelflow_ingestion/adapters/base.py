"""ContentSourceAdapter contract. Ingestion is never coupled to one platform."""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any

from reelflow_network import NetworkClient


class UnsupportedSourceOperation(Exception):
    """The requested operation has no official/authorized integration. We stop here
    instead of building a workaround; `reason` is shown to the user."""

    code = "UNSUPPORTED_SOURCE_OPERATION"

    def __init__(self, operation: str, reason: str) -> None:
        super().__init__(f"{operation}: {reason}")
        self.operation = operation
        self.reason = reason


class SourceInvalid(ValueError):
    code = "SOURCE_UNAVAILABLE"


@dataclass(frozen=True)
class SourceRecord:
    id: str
    name: str
    platform: str
    url: str | None
    rights_status: str
    attribution_text: str | None
    allowed_media_types: tuple[str, ...]
    max_items: int
    adapter_options: dict[str, Any]


@dataclass
class DiscoveredItem:
    external_id: str
    url: str | None
    media_url: str | None
    caption: str | None = None
    author: str | None = None
    created_at: datetime | None = None
    media_type_hint: str | None = None  # VIDEO | IMAGE when known
    hashtags: list[str] = field(default_factory=list)

    def to_metadata(self) -> dict[str, Any]:
        return {
            "externalId": self.external_id,
            "url": self.url,
            "mediaUrl": self.media_url,
            "caption": self.caption,
            "author": self.author,
            "createdAt": self.created_at.isoformat() if self.created_at else None,
            "mediaTypeHint": self.media_type_hint,
            "hashtags": self.hashtags,
        }

    @classmethod
    def from_metadata(cls, m: dict[str, Any]) -> "DiscoveredItem":
        created = m.get("createdAt")
        return cls(
            external_id=m["externalId"],
            url=m.get("url"),
            media_url=m.get("mediaUrl"),
            caption=m.get("caption"),
            author=m.get("author"),
            created_at=datetime.fromisoformat(created) if created else None,
            media_type_hint=m.get("mediaTypeHint"),
            hashtags=list(m.get("hashtags") or []),
        )


@dataclass(frozen=True)
class NormalizedMetadata:
    caption: str | None
    author: str | None
    created_at: datetime | None
    hashtags: list[str]
    original_url: str | None


class ContentSourceAdapter(ABC):
    platform: str

    @abstractmethod
    async def validate_source(self, source: SourceRecord) -> None:
        """Raise SourceInvalid if the source cannot be used."""

    @abstractmethod
    async def discover_content(self, source: SourceRecord, client: NetworkClient, limit: int) -> list[DiscoveredItem]:
        """List new items. Must only use authorized/public mechanisms."""

    async def fetch_metadata(self, source: SourceRecord, item: DiscoveredItem, client: NetworkClient) -> DiscoveredItem:
        return item

    @abstractmethod
    async def download_authorized_media(self, source: SourceRecord, item: DiscoveredItem, client: NetworkClient, dest: Path, max_bytes: int) -> Path:
        """Download media the operator is permitted to use to `dest`."""

    def normalize_metadata(self, item: DiscoveredItem) -> NormalizedMetadata:
        tags = list(item.hashtags)
        if item.caption:
            tags += [w[1:] for w in item.caption.split() if w.startswith("#") and len(w) > 1]
        return NormalizedMetadata(
            caption=(item.caption or "").strip() or None,
            author=(item.author or "").strip().lstrip("@") or None,
            created_at=item.created_at,
            hashtags=list(dict.fromkeys(t.strip("#,.!") for t in tags if t.strip("#,.!")))[:30],
            original_url=item.url,
        )
