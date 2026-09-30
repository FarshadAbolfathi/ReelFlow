"""Direct media URLs the operator has permission to use, plus an optional yt-dlp
path for sites the operator explicitly allow-lists (never Instagram/Facebook/TikTok)."""

from __future__ import annotations

import asyncio
import os
import shutil
from pathlib import Path
from urllib.parse import urlsplit

from reelflow_network import NetworkClient, validate_public_url

from ..settings import BLOCKED_DOWNLOAD_PLATFORMS
from .base import ContentSourceAdapter, DiscoveredItem, SourceInvalid, SourceRecord, UnsupportedSourceOperation

MEDIA_EXTENSIONS = (".mp4", ".mov", ".m4v", ".webm", ".jpg", ".jpeg", ".png", ".webp")


def platform_of(url: str) -> str:
    host = (urlsplit(url).hostname or "").lower()
    parts = host.split(".")
    return parts[-2] if len(parts) >= 2 else host


class DirectUrlAdapter(ContentSourceAdapter):
    platform = "DIRECT_URL"

    def __init__(self, ytdlp_allowed: frozenset[str] = frozenset()) -> None:
        self.ytdlp_allowed = ytdlp_allowed - BLOCKED_DOWNLOAD_PLATFORMS

    async def validate_source(self, source: SourceRecord) -> None:
        if source.url:
            validate_public_url(source.url)

    async def discover_content(self, source: SourceRecord, client: NetworkClient, limit: int) -> list[DiscoveredItem]:
        raise UnsupportedSourceOperation("discover_content", "Direct-URL sources have nothing to discover; import individual links instead.")

    async def download_authorized_media(self, source: SourceRecord | None, item: DiscoveredItem, client: NetworkClient, dest: Path, max_bytes: int) -> Path:
        url = item.media_url or item.url
        if not url:
            raise SourceInvalid("No URL to download")
        validate_public_url(url)
        site = platform_of(url)
        if site in BLOCKED_DOWNLOAD_PLATFORMS:
            raise UnsupportedSourceOperation(
                "download_authorized_media",
                f"Downloading from {site} is not supported: its terms forbid automated downloads. Ask the owner for the file and upload it.",
            )
        if urlsplit(url).path.lower().endswith(MEDIA_EXTENSIONS) or site not in self.ytdlp_allowed:
            await client.download(url, dest, max_bytes=max_bytes)
            return dest
        return await self._ytdlp(url, client, dest, max_bytes)

    async def _ytdlp(self, url: str, client: NetworkClient, dest: Path, max_bytes: int) -> Path:
        exe = shutil.which("yt-dlp")
        if not exe:
            raise UnsupportedSourceOperation("download_authorized_media", "yt-dlp is not installed (pip install 'reelflow-ingestion[ytdlp]')")
        await client.assert_available()  # fail closed before spawning
        out_tmpl = str(dest.with_suffix("")) + ".%(ext)s"
        argv = [
            exe, "--no-playlist", "--no-progress", "--ignore-config", "--no-cookies-from-browser",
            "--max-filesize", str(max_bytes), "-f", "mp4/best[ext=mp4]/best",
            *client.subprocess_proxy_args(),  # explicit --proxy; env proxies are not inherited
            "-o", out_tmpl, "--", url,
        ]
        env = {k: v for k, v in os.environ.items() if "proxy" not in k.lower()}
        proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=env)
        _out, err = await asyncio.wait_for(proc.communicate(), 900)
        if proc.returncode != 0:
            raise SourceInvalid(f"yt-dlp failed: {err.decode(errors='replace').strip().splitlines()[-1:]}")
        produced = next(iter(sorted(dest.parent.glob(dest.with_suffix("").name + ".*"))), None)
        if not produced:
            raise SourceInvalid("yt-dlp produced no file")
        produced.replace(dest)
        return dest
