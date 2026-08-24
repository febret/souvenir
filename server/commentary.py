from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException

from .media import media_url, normalize_relative, relative_text

COMMENTARY_TYPES = {
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".m4a": "audio/mp4",
    ".aac": "audio/aac",
    ".webm": "audio/webm",
}


def commentary_type(path: Path) -> str | None:
    return COMMENTARY_TYPES.get(path.suffix.lower())


def resolve_commentary_file(root: Path, path: str | Path | None) -> tuple[Path, Path]:
    relative = normalize_relative(path)
    if not relative.parts:
        raise HTTPException(404, "commentary file was not found")
    if any(part.startswith(".") for part in relative.parts):
        raise HTTPException(404, "commentary file was not found")
    candidate = root / relative
    _reject_symlink_components(root, relative)
    try:
        resolved = candidate.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, RuntimeError, ValueError):
        raise HTTPException(404, "commentary file was not found") from None
    if not resolved.is_file():
        raise HTTPException(404, "commentary file was not found")
    if commentary_type(resolved) is None:
        raise HTTPException(404, "unsupported commentary type")
    return resolved, resolved.relative_to(root)


def commentary_entries(
    root: Path,
    assignments: dict[str, list[str]],
    captions: dict[str, str] | None = None,
    volumes: dict[str, float] | None = None,
) -> list[dict]:
    caption_lookup = captions or {}
    volume_lookup = volumes or {}
    entries: list[dict] = []
    pending = [root]
    while pending:
        directory = pending.pop()
        try:
            with os.scandir(directory) as children:
                for child in children:
                    if child.name.startswith("."):
                        continue
                    path = Path(child.path)
                    try:
                        if child.is_symlink():
                            continue
                        path.resolve(strict=True).relative_to(root)
                        if child.is_dir(follow_symlinks=False):
                            pending.append(path)
                            continue
                        if not child.is_file(follow_symlinks=False) or commentary_type(path) is None:
                            continue
                        relative = path.relative_to(root)
                        stat = path.stat()
                    except (OSError, RuntimeError, ValueError):
                        continue
                    text = relative_text(relative)
                    entries.append(
                        {
                            "name": path.name,
                            "path": text,
                            "media_type": commentary_type(path),
                            "size": stat.st_size,
                            "mtime": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                            "url": media_url(relative, "/api/commentary/file"),
                            "tag_ids": list(assignments.get(text, [])),
                            "caption": caption_lookup.get(text, ""),
                            "volume": volume_lookup.get(text, 1.0),
                        }
                    )
        except OSError:
            continue
    return sorted(entries, key=lambda entry: (entry["name"].casefold(), entry["path"].casefold()))


def _reject_symlink_components(root: Path, relative: Path) -> None:
    candidate = root
    for part in relative.parts:
        candidate /= part
        try:
            if candidate.is_symlink():
                raise HTTPException(404, "commentary file was not found")
        except OSError:
            raise HTTPException(404, "commentary file was not found") from None
