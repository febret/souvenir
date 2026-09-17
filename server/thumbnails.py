from __future__ import annotations

import shutil
import subprocess
import tempfile
import threading
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps

from .media import (
    IMAGE_SUFFIXES,
    POSTER_TIME_MAX,
    POSTER_TIME_MIN,
    VIDEO_SUFFIXES,
    cache_path,
    clamp_poster_time,
    thumbnail_is_current,
)

THUMBNAIL_SIZE = (480, 360)
_FFMPEG_TIMEOUT_SECONDS = 15

_locks_guard = threading.Lock()
_locks: dict[str, threading.Lock] = {}
_ffmpeg_checked: bool = False
_ffmpeg_available: bool = False


def _lock_for(key: str) -> threading.Lock:
    with _locks_guard:
        existing = _locks.get(key)
        if existing is None:
            existing = threading.Lock()
            _locks[key] = existing
        return existing


def _ffmpeg_exists() -> bool:
    global _ffmpeg_checked, _ffmpeg_available
    with _locks_guard:
        if _ffmpeg_checked:
            return _ffmpeg_available
        _ffmpeg_available = shutil.which("ffmpeg") is not None
        _ffmpeg_checked = True
        return _ffmpeg_available


def _clamp_poster_time(value: object) -> float:
    return clamp_poster_time(value)


def _extract_video_frame(source: Path, poster_time: float) -> bytes | None:
    if not _ffmpeg_exists():
        return None
    try:
        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as handle:
            frame_path = Path(handle.name)
    except OSError:
        return None
    try:
        completed = subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                str(poster_time),
                "-i",
                str(source),
                "-vframes",
                "1",
                "-q:v",
                "4",
                str(frame_path),
            ],
            capture_output=True,
            timeout=_FFMPEG_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0 or not frame_path.is_file():
            return None
        return frame_path.read_bytes()
    except (OSError, subprocess.SubprocessError, ValueError):
        return None
    finally:
        try:
            frame_path.unlink(missing_ok=True)
        except OSError:
            pass


def create_thumbnail(
    root: Path,
    source: Path,
    relative: Path,
    *,
    poster_time: float = 1.0,
) -> Path:
    clamped = _clamp_poster_time(poster_time)
    if source.suffix.lower() in IMAGE_SUFFIXES:
        target = cache_path(root, relative)
        with _lock_for(f"img:{target.name}"):
            if thumbnail_is_current(target, source):
                return target
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            _image_thumbnail(source, target)
        return target
    target = cache_path(root, relative, poster_time=clamped)
    with _lock_for(f"vid:{target.name}"):
        if thumbnail_is_current(target, source):
            return target
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        frame = _extract_video_frame(source, clamped) if source.suffix.lower() in VIDEO_SUFFIXES else None
        if frame:
            try:
                _frame_thumbnail(frame, target)
                return target
            except (OSError, ValueError):
                pass
        # Fall back to the drawn placeholder (also covers unknown suffixes).
        _video_placeholder(source.name, target)
        return target


def _image_thumbnail(source: Path, target: Path) -> None:
    with Image.open(source) as image:
        _save_frame(image, target)


def _frame_thumbnail(frame: bytes, target: Path) -> None:
    with Image.open(BytesIO(frame)) as image:
        _save_frame(image, target)


def _save_frame(image: Image.Image, target: Path) -> None:
    image = ImageOps.exif_transpose(image)
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    image.thumbnail(THUMBNAIL_SIZE)
    image.save(target, "JPEG", quality=85, optimize=True)


def _video_placeholder(name: str, target: Path) -> None:
    image = Image.new("RGB", THUMBNAIL_SIZE, "#172033")
    draw = ImageDraw.Draw(image)
    width, height = THUMBNAIL_SIZE
    for y in range(height):
        blue = 50 + int(55 * y / height)
        draw.line((0, y, width, y), fill=(21, 31, blue))
    triangle = [(width // 2 - 38, height // 2 - 52), (width // 2 - 38, height // 2 + 52), (width // 2 + 56, height // 2)]
    draw.polygon(triangle, fill="#ffffff")
    label = name if len(name) <= 48 else f"{name[:45]}..."
    draw.text((24, height - 40), label, fill="#d8e5ff")
    draw.text((24, 24), "VIDEO", fill="#8fb7ff")
    image.save(target, "JPEG", quality=88, optimize=True)
