"""Local inbox folder: the operator drops files received from page owners (with
permission) into storage/inbox/<folder>/. No network access at all."""

from __future__ import annotations

import hashlib
import re
import shutil
from datetime import UTC, datetime
from pathlib import Path

from reelflow_network import NetworkClient

from .base import ContentSourceAdapter, DiscoveredItem, SourceInvalid, SourceRecord

MEDIA_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".jpg", ".jpeg", ".png", ".webp"}
IMPORTED_DIR = ".imported"


def folder_name(source: SourceRecord) -> str:
    raw = str(source.adapter_options.get("folder") or source.name)
    safe = re.sub(r"[^A-Za-z0-9_-]+", "-", raw).strip("-").lower()
    return safe or source.id


class LocalFolderAdapter(ContentSourceAdapter):
    platform = "LOCAL"

    def __init__(self, inbox_root: Path) -> None:
        self.inbox_root = inbox_root.resolve()

    def folder(self, source: SourceRecord) -> Path:
        p = (self.inbox_root / folder_name(source)).resolve()
        if not p.is_relative_to(self.inbox_root):
            raise SourceInvalid("Inbox folder escapes the inbox root")
        return p

    async def validate_source(self, source: SourceRecord) -> None:
        self.folder(source).mkdir(parents=True, exist_ok=True)

    async def discover_content(self, source: SourceRecord, client: NetworkClient, limit: int) -> list[DiscoveredItem]:
        folder = self.folder(source)
        folder.mkdir(parents=True, exist_ok=True)
        items: list[DiscoveredItem] = []
        for f in sorted(folder.iterdir(), key=lambda p: p.stat().st_mtime):
            if not f.is_file() or f.is_symlink() or f.suffix.lower() not in MEDIA_EXT or f.name.startswith("."):
                continue
            st = f.stat()
            ext_id = hashlib.sha256(f"{f.name}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:32]
            sidecar = f.with_suffix(".txt")
            caption = sidecar.read_text(errors="replace")[:2200] if sidecar.is_file() else None
            items.append(
                DiscoveredItem(
                    external_id=f"local:{ext_id}",
                    url=None,
                    media_url=f.name,  # relative to the source folder
                    caption=caption,
                    created_at=datetime.fromtimestamp(st.st_mtime, UTC),
                )
            )
            if len(items) >= limit:
                break
        return items

    async def download_authorized_media(self, source: SourceRecord, item: DiscoveredItem, client: NetworkClient, dest: Path, max_bytes: int) -> Path:
        folder = self.folder(source)
        src = (folder / (item.media_url or "")).resolve()
        if not src.is_relative_to(folder) or not src.is_file():
            raise SourceInvalid("Inbox file not found")
        if src.stat().st_size > max_bytes:
            raise SourceInvalid("File exceeds the size limit")
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        # Move the source file aside so it is not rediscovered.
        done = folder / IMPORTED_DIR
        done.mkdir(exist_ok=True)
        src.rename(done / src.name)
        return dest
