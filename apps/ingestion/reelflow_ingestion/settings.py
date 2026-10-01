"""Settings from the shared repo-root .env (real environment variables win)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from pydantic import BaseModel

from reelflow_network import ProxyConfig

# Platforms whose terms forbid automated downloading of other accounts' media.
# yt-dlp is never used for these, whatever YTDLP_ALLOWED_EXTRACTORS says.
BLOCKED_DOWNLOAD_PLATFORMS = frozenset({"instagram", "facebook", "fb", "tiktok", "threads"})


def repo_root() -> Path:
    here = Path(__file__).resolve()
    for p in here.parents:
        if (p / ".env.example").is_file() and (p / "package.json").is_file():
            return p
    return Path.cwd()


class IngestionSettings(BaseModel):
    database_url: str
    redis_url: str
    storage_path: Path
    inbox_path: Path
    upload_max_bytes: int
    ytdlp_allowed_extractors: frozenset[str]
    proxy: ProxyConfig
    consumer_name: str
    log_level: str
    # Same key as the Node side; decrypts Instagram login sessions. Empty → sessions disabled.
    encryption_key: str = ""
    instagram_transport: str = "auto"

    @property
    def async_database_url(self) -> str:
        url = self.database_url.split("?")[0]
        return url.replace("postgresql://", "postgresql+asyncpg://", 1).replace("postgres://", "postgresql+asyncpg://", 1)


@lru_cache(maxsize=1)
def load_settings(env: tuple[tuple[str, str], ...] | None = None) -> IngestionSettings:
    root = repo_root()
    if env is None:
        load_dotenv(root / ".env", override=False)
        e = dict(os.environ)
    else:
        e = dict(env)
    storage = (root / e.get("STORAGE_PATH", "./storage")).resolve()
    inbox = (root / e.get("INGEST_INBOX_PATH", "./storage/inbox")).resolve()
    allowed = {x.strip().lower() for x in e.get("YTDLP_ALLOWED_EXTRACTORS", "").split(",") if x.strip()}
    return IngestionSettings(
        database_url=e["DATABASE_URL"],
        redis_url=e.get("REDIS_URL", "redis://127.0.0.1:6380"),
        storage_path=storage,
        inbox_path=inbox,
        upload_max_bytes=int(e.get("UPLOAD_MAX_BYTES", str(500 * 1024 * 1024))),
        ytdlp_allowed_extractors=frozenset(allowed - BLOCKED_DOWNLOAD_PLATFORMS),
        proxy=ProxyConfig.from_env(e),
        consumer_name=e.get("INGESTION_CONSUMER", f"ingestion-{os.getpid()}"),
        log_level=e.get("LOG_LEVEL", "info"),
        encryption_key=e.get("ENCRYPTION_KEY", ""),
        instagram_transport=e.get("INSTAGRAM_TRANSPORT", "auto").strip().lower() or "auto",
    )
