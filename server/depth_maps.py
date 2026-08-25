from __future__ import annotations

import hashlib
import json
import os
import threading
import uuid
import warnings
from datetime import datetime, timezone
from io import BytesIO
from pathlib import Path

from fastapi import HTTPException
from PIL import Image, UnidentifiedImageError

from .media import DEPTH_DIRECTORY, INTERNAL_DIRECTORIES, media_type, media_url, relative_text, resolve_under_root

MAX_DEPTH_MAP_BYTES = 16 * 1024 * 1024
MAX_DEPTH_DIMENSION = 2048


class DepthMapStore:
    def __init__(self, root: Path) -> None:
        self._root = root
        self._directory = root / DEPTH_DIRECTORY
        self._lock = threading.RLock()

    def image_relative(self, path: str) -> Path:
        source, relative = resolve_under_root(self._root, path, directory=False)
        source_type = media_type(source)
        if any(part in INTERNAL_DIRECTORIES for part in relative.parts) or source_type is None or not source_type.startswith("image/"):
            raise HTTPException(404, "unsupported media type")
        return relative

    def info(self, relative: Path) -> dict[str, bool | str | None]:
        with self._lock:
            metadata = self._load_metadata(relative)
            return self._info(relative, metadata)

    def read(self, relative: Path) -> bytes:
        with self._lock:
            metadata = self._load_metadata(relative)
            if metadata is None:
                raise HTTPException(404, "depth map was not found")
            depth_path, _ = self._paths(relative)
            try:
                return depth_path.read_bytes()
            except OSError as error:
                raise HTTPException(500, "depth storage could not be read") from error

    def write(self, relative: Path, data: bytes) -> dict[str, bool | str | None]:
        normalized = normalize_depth_png(data)
        metadata = {
            "path": relative_text(relative),
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        with self._lock:
            self._ensure_directory()
            previous_metadata = self._load_metadata(relative)
            depth_path, metadata_path = self._paths(relative)
            try:
                previous_data = depth_path.read_bytes() if previous_metadata else None
            except OSError as error:
                raise HTTPException(500, "depth storage could not be read") from error
            depth_temp = self._temporary_path(depth_path)
            metadata_temp = self._temporary_path(metadata_path)
            depth_replaced = False
            try:
                self._write_file(depth_temp, normalized)
                self._write_file(metadata_temp, json.dumps(metadata, separators=(",", ":")).encode("utf-8"))
                os.replace(depth_temp, depth_path)
                depth_replaced = True
                os.replace(metadata_temp, metadata_path)
            except OSError as error:
                self._cleanup_temps(depth_temp, metadata_temp)
                if depth_replaced:
                    try:
                        if previous_data is None:
                            depth_path.unlink()
                        else:
                            self._restore_file(depth_path, previous_data)
                    except OSError as rollback_error:
                        raise HTTPException(
                            500,
                            "depth storage update failed and could not be rolled back",
                        ) from rollback_error
                raise HTTPException(500, "depth storage could not be updated") from error
            return self._info(relative, metadata)

    def delete(self, relative: Path) -> dict[str, bool | str | None]:
        with self._lock:
            metadata = self._load_metadata(relative)
            if metadata is None:
                return self._info(relative, None)
            depth_path, metadata_path = self._paths(relative)
            try:
                depth_data = depth_path.read_bytes()
                metadata_data = metadata_path.read_bytes()
                depth_path.unlink()
                metadata_path.unlink()
            except OSError as error:
                try:
                    if not depth_path.exists() and "depth_data" in locals():
                        self._restore_file(depth_path, depth_data)
                    if not metadata_path.exists() and "metadata_data" in locals():
                        self._restore_file(metadata_path, metadata_data)
                except OSError as rollback_error:
                    raise HTTPException(
                        500,
                        "depth storage deletion failed and could not be rolled back",
                    ) from rollback_error
                raise HTTPException(500, "depth storage could not be deleted") from error
            return self._info(relative, None)

    def _paths(self, relative: Path) -> tuple[Path, Path]:
        digest = hashlib.sha256(relative_text(relative).encode("utf-8")).hexdigest()
        return self._directory / f"{digest}.png", self._directory / f"{digest}.json"

    def _ensure_directory(self) -> None:
        if self._directory.is_symlink() or (self._directory.exists() and not self._directory.is_dir()):
            raise HTTPException(500, "depth storage directory is invalid")
        try:
            self._directory.mkdir(mode=0o700, exist_ok=True)
        except OSError as error:
            raise HTTPException(500, "depth storage directory could not be created") from error

    def _temporary_path(self, destination: Path) -> Path:
        temporary = self._directory / f".{destination.name}.{uuid.uuid4().hex}.tmp"
        try:
            temporary.relative_to(self._directory)
        except ValueError as error:
            raise HTTPException(500, "depth temporary path is invalid") from error
        return temporary

    @staticmethod
    def _write_file(path: Path, data: bytes) -> None:
        with path.open("xb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())

    def _restore_file(self, destination: Path, data: bytes) -> None:
        temporary = self._temporary_path(destination)
        try:
            self._write_file(temporary, data)
            os.replace(temporary, destination)
        except OSError:
            self._cleanup_temps(temporary)
            raise

    @staticmethod
    def _cleanup_temps(*paths: Path) -> None:
        for path in paths:
            try:
                path.unlink()
            except FileNotFoundError:
                continue
            except OSError:
                continue

    def _load_metadata(self, relative: Path) -> dict[str, str] | None:
        depth_path, metadata_path = self._paths(relative)
        if depth_path.is_symlink() or metadata_path.is_symlink():
            raise HTTPException(500, "depth storage is invalid")
        depth_exists = depth_path.exists()
        metadata_exists = metadata_path.exists()
        if depth_exists != metadata_exists:
            raise HTTPException(500, "depth storage is inconsistent")
        if not depth_exists:
            return None
        if not depth_path.is_file() or not metadata_path.is_file():
            raise HTTPException(500, "depth storage is invalid")
        try:
            loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HTTPException(500, "depth metadata is malformed") from error
        if not isinstance(loaded, dict):
            raise HTTPException(500, "depth metadata is malformed")
        path = loaded.get("path")
        updated_at = loaded.get("updated_at")
        if path != relative_text(relative) or not isinstance(updated_at, str):
            raise HTTPException(500, "depth metadata is malformed")
        try:
            parsed = datetime.fromisoformat(updated_at)
        except ValueError as error:
            raise HTTPException(500, "depth metadata is malformed") from error
        if parsed.tzinfo is None:
            raise HTTPException(500, "depth metadata is malformed")
        return {"path": path, "updated_at": updated_at}

    @staticmethod
    def _info(relative: Path, metadata: dict[str, str] | None) -> dict[str, bool | str | None]:
        if metadata is None:
            return {
                "exists": False,
                "path": relative_text(relative),
                "updated_at": None,
                "url": None,
            }
        return {
            "exists": True,
            "path": relative_text(relative),
            "updated_at": metadata["updated_at"],
            "url": media_url(relative, "/api/depth"),
        }


def normalize_depth_png(data: bytes) -> bytes:
    if not data:
        raise HTTPException(422, "depth PNG must not be empty")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as verified:
                if verified.format != "PNG":
                    raise HTTPException(422, "depth body must be a PNG")
                verified.verify()
            with Image.open(BytesIO(data)) as image:
                if image.format != "PNG":
                    raise HTTPException(422, "depth body must be a PNG")
                width, height = image.size
                if not 0 < width <= MAX_DEPTH_DIMENSION or not 0 < height <= MAX_DEPTH_DIMENSION:
                    raise HTTPException(422, "depth dimensions must not exceed 2048 pixels")
                image.load()
                normalized = image.convert("L")
                output = BytesIO()
                normalized.save(output, format="PNG")
                return output.getvalue()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(422, "depth body must be a valid PNG") from error
