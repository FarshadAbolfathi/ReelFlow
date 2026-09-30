"""Perceptual fingerprints for duplicate detection (layers 3–4).

Images: 64-bit difference hash (dHash) — robust to resizing, re-encoding and
small watermarks. Videos: dHash of frames sampled at fixed fractions of the
duration, compared frame-by-frame by mean Hamming distance.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

from .media import run_tool

SAMPLE_FRACTIONS = (0.1, 0.3, 0.5, 0.7, 0.9)
IMAGE_THRESHOLD = 6  # bits of 64
VIDEO_THRESHOLD = 8.0  # mean bits of 64 per frame


def dhash_pixels(pixels: bytes | list[int], width: int = 9, height: int = 8) -> str:
    bits = 0
    for y in range(height):
        row = pixels[y * width : (y + 1) * width]
        for x in range(width - 1):
            bits = (bits << 1) | (1 if row[x] > row[x + 1] else 0)
    return f"{bits:016x}"


def image_dhash(path: Path) -> str:
    with Image.open(path) as im:
        small = im.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
        return dhash_pixels(small.tobytes())


def hamming(a: str, b: str) -> int:
    return (int(a, 16) ^ int(b, 16)).bit_count()


async def video_fingerprint(path: Path, duration: float | None) -> list[str]:
    if not duration or duration <= 0:
        return []
    hashes: list[str] = []
    for frac in SAMPLE_FRACTIONS:
        raw = await run_tool(
            ["ffmpeg", "-v", "error", "-nostdin", "-ss", f"{duration * frac:.3f}", "-i", str(path), "-frames:v", "1",
             "-vf", "scale=9:8:flags=area,format=gray", "-f", "rawvideo", "-"],
            60,
        )
        if len(raw) >= 72:
            hashes.append(dhash_pixels(raw[:72]))
    return hashes


def video_distance(a: list[str], b: list[str]) -> float | None:
    n = min(len(a), len(b))
    if n < 3:
        return None
    return sum(hamming(x, y) for x, y in zip(a[:n], b[:n], strict=True)) / n
