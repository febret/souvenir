from __future__ import annotations

import hashlib
import mimetypes
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable
from urllib.parse import quote

from fastapi import HTTPException

MEDIA_TYPES = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
    ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4",
    ".webm": "video/webm",
}
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".gif"}
VIDEO_SUFFIXES = {".mp4", ".webm"}
CACHE_DIRECTORY = ".souvenir-thumbnails"
MASK_DIRECTORY = ".souvenir-masks"
DEPTH_DIRECTORY = ".souvenir-depth"
TAG_STORAGE_FILE = ".souvenir-tags.json"
SCENE_STORAGE_FILE = ".souvenir-scenes.json"
INTERNAL_DIRECTORIES = {CACHE_DIRECTORY, MASK_DIRECTORY, DEPTH_DIRECTORY, ".souvenir-certs"}
INTERNAL_FILES = {TAG_STORAGE_FILE, SCENE_STORAGE_FILE}


def normalize_relative(path: str | Path | None) -> Path:
    text = "" if path is None else str(path)
    text = text.replace("\\", "/")
    if not text or text == ".":
        return Path()
    if text.startswith("/") or re.match(r"^[A-Za-z]:", text):
        raise HTTPException(400, "path must be relative")
    candidate = Path(text)
    if any(part in ("", ".", "..") for part in candidate.parts):
        raise HTTPException(400, "path traversal is not allowed")
    return candidate


def resolve_under_root(root: Path, relative_path: str | Path | None, *, directory: bool | None = None) -> tuple[Path, Path]:
    relative = normalize_relative(relative_path)
    try:
        resolved = (root / relative).resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError, RuntimeError):
        raise HTTPException(404, "media path was not found") from None
    if directory is True and not resolved.is_dir():
        raise HTTPException(404, "directory was not found")
    if directory is False and not resolved.is_file():
        raise HTTPException(404, "media file was not found")
    return resolved, relative


def media_type(path: Path) -> str | None:
    return MEDIA_TYPES.get(path.suffix.lower())


def is_media(path: Path) -> bool:
    return path.is_file() and media_type(path) is not None


def relative_text(path: Path) -> str:
    return "" if path == Path() or str(path) == "." else path.as_posix()


def is_internal_path(relative: Path) -> bool:
    return relative.name in INTERNAL_FILES or any(part in INTERNAL_DIRECTORIES for part in relative.parts)


def media_url(relative: Path, endpoint: str) -> str:
    return f"{endpoint}?path={quote(relative_text(relative), safe='/')}"


def metadata(root: Path, path: Path, *, tag_ids: list[str] | None = None) -> dict:
    relative = path.relative_to(root)
    stat = path.stat()
    kind = "directory" if path.is_dir() else "file"
    result = {
        "name": path.name,
        "path": relative_text(relative),
        "kind": kind,
        "media_type": media_type(path) if kind == "file" else None,
        "size": stat.st_size if kind == "file" else None,
        "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "url": None,
        "thumbnail_url": None,
        "tag_ids": tag_ids or [],
    }
    if kind == "file" and result["media_type"]:
        result["url"] = media_url(relative, "/api/file")
        result["thumbnail_url"] = media_url(relative, "/api/thumbnail")
    return result


def parse_included_dirs(values: Iterable[str] | None, root: Path) -> tuple[Path, ...]:
    if not values:
        return ()
    paths: list[Path] = []
    for value in values:
        for part in value.split(","):
            if not part.strip():
                continue
            resolved, relative = resolve_under_root(root, part.strip(), directory=True)
            if relative not in paths:
                paths.append(relative)
    return tuple(paths)


def is_allowed(relative: Path, included: tuple[Path, ...]) -> bool:
    if not included:
        return True
    return any(relative == item or item in relative.parents or relative in item.parents for item in included)


def cache_path(root: Path, relative: Path) -> Path:
    digest = hashlib.sha256(relative_text(relative).encode("utf-8")).hexdigest()
    return root / CACHE_DIRECTORY / f"{digest}.jpg"


def thumbnail_is_current(cache: Path, source: Path) -> bool:
    try:
        return cache.is_file() and cache.stat().st_mtime_ns >= source.stat().st_mtime_ns
    except OSError:
        return False


def content_type(path: Path) -> str:
    return media_type(path) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"
