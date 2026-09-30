"""Media inspection: magic-byte sniffing, SHA-256, ffprobe. No shell is ever used."""

from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass
from pathlib import Path


class MediaInvalidError(ValueError):
    code = "MEDIA_INVALID"


@dataclass(frozen=True)
class Sniffed:
    media_type: str  # VIDEO | IMAGE
    mime: str
    ext: str


def sniff(head: bytes) -> Sniffed | None:
    if len(head) < 12:
        return None
    if head[:3] == b"\xff\xd8\xff":
        return Sniffed("IMAGE", "image/jpeg", ".jpg")
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return Sniffed("IMAGE", "image/png", ".png")
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return Sniffed("IMAGE", "image/webp", ".webp")
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand == b"qt  ":
            return Sniffed("VIDEO", "video/quicktime", ".mov")
        if brand[:3] in (b"iso", b"mp4", b"avc", b"M4V", b"das", b"mmp", b"MSN", b"3gp"):
            return Sniffed("VIDEO", "video/mp4", ".mp4")
        return None
    if head[:4] == b"\x1a\x45\xdf\xa3":
        return Sniffed("VIDEO", "video/webm", ".webm") if b"webm" in head else Sniffed("VIDEO", "video/x-matroska", ".mkv")
    return None


def sniff_file(path: Path) -> Sniffed | None:
    with path.open("rb") as f:
        return sniff(f.read(64))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


@dataclass(frozen=True)
class Probe:
    media_type: str
    duration: float | None
    width: int
    height: int
    fps: float | None
    video_codec: str | None
    audio_codec: str | None


async def run_tool(argv: list[str], timeout: float = 120.0) -> bytes:
    proc = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout)
    except TimeoutError:
        proc.kill()
        raise MediaInvalidError(f"{argv[0]} timed out") from None
    if proc.returncode != 0:
        raise MediaInvalidError(f"{argv[0]} failed: {err.decode(errors='replace').strip().splitlines()[-1:]}")
    return out


async def probe(path: Path, sniffed: Sniffed) -> Probe:
    raw = await run_tool(["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", "--", str(path)], 60)
    data = json.loads(raw)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video or not video.get("width"):
        raise MediaInvalidError("No video/image stream")
    fps = None
    if sniffed.media_type == "VIDEO" and video.get("avg_frame_rate", "0/0") != "0/0":
        n, d = (int(x) for x in video["avg_frame_rate"].split("/"))
        fps = round(n / d, 3) if d else None
    dur = data.get("format", {}).get("duration") or video.get("duration")
    return Probe(
        media_type=sniffed.media_type,
        duration=float(dur) if dur and sniffed.media_type == "VIDEO" else None,
        width=int(video["width"]),
        height=int(video["height"]),
        fps=fps,
        video_codec=video.get("codec_name"),
        audio_codec=audio.get("codec_name") if audio else None,
    )
