from __future__ import annotations

import os
from pathlib import Path

from fastapi import HTTPException

from .media import TRASH_DIRECTORY, is_internal_path


def move_media(root: Path, relative: Path) -> Path:
    """Move a media file into the internal .trashcan directory.

    The destination mirrors the media file's relative directory structure
    under the trash root and keeps ``relative``'s existing parents separate
    from any collision suffix. Returns the absolute trash path.
    """
    if is_internal_path(relative):
        raise HTTPException(404, "media path was not found")
    source = (root / relative).resolve(strict=True)
    try:
        source.relative_to(root)
    except ValueError as error:
        raise HTTPException(404, "media path was not found") from error
    if not source.is_file():
        raise HTTPException(404, "media file was not found")

    trash_root = root / TRASH_DIRECTORY
    try:
        resolved = trash_root.resolve(strict=False)
        resolved.relative_to(root)
    except (OSError, ValueError, RuntimeError) as error:
        raise HTTPException(500, "trash directory is invalid") from error
    if trash_root.exists() and not trash_root.is_dir():
        raise HTTPException(500, "trash directory is invalid")
    try:
        trash_root.mkdir(mode=0o700, exist_ok=True)
    except OSError as error:
        raise HTTPException(500, "trash directory could not be created") from error

    destination = _unique_destination(trash_root / relative)
    try:
        destination.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, destination)
    except OSError as error:
        raise HTTPException(500, "media could not be moved to the trash") from error
    return destination


def _unique_destination(destination: Path) -> Path:
    if not _exists(destination):
        return destination
    parent = destination.parent
    stem = destination.stem
    suffix = destination.suffix
    index = 1
    while _exists(parent / f"{stem} ({index}){suffix}"):
        index += 1
    return parent / f"{stem} ({index}){suffix}"


def _exists(path: Path) -> bool:
    return path.exists() or path.is_symlink()