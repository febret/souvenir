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
from typing import Literal

from fastapi import HTTPException
from PIL import Image, ImageFilter, UnidentifiedImageError

from .media import INTERNAL_DIRECTORIES, MASK_DIRECTORY, media_type, media_url, relative_text, resolve_under_root

MAX_MASK_BYTES = 16 * 1024 * 1024
MAX_MASK_DIMENSION = 2048


class MaskStore:
    """Persistent normalized erase masks for media files under one library root."""

    def __init__(self, root: Path) -> None:
        self._root = root
        self._directory = root / MASK_DIRECTORY
        self._lock = threading.RLock()

    def media_relative(self, path: str) -> Path:
        source, relative = resolve_under_root(self._root, path, directory=False)
        if any(part in INTERNAL_DIRECTORIES for part in relative.parts) or media_type(source) is None:
            raise HTTPException(404, "unsupported media type")
        return relative

    def info(self, relative: Path) -> dict[str, bool | int | str | None]:
        with self._lock:
            metadata = self._load_metadata(relative)
            return self._info(relative, metadata)

    def read(self, relative: Path, *, variant: Literal["display", "binary"] = "display") -> bytes:
        with self._lock:
            metadata = self._load_metadata(relative)
            if metadata is None:
                raise HTTPException(404, "mask was not found")
            binary_path, display_path, _ = self._paths(relative)
            try:
                if variant == "binary":
                    return binary_path.read_bytes()
                if display_path.exists():
                    if display_path.is_symlink() or not display_path.is_file():
                        raise HTTPException(500, "mask storage is invalid")
                    return display_path.read_bytes()
                return blurred_mask_png(binary_path.read_bytes(), int(metadata["blur"]))
            except OSError as error:
                raise HTTPException(500, "mask storage could not be read") from error

    def write(self, relative: Path, data: bytes, blur: int) -> dict[str, bool | int | str | None]:
        normalized_binary = normalize_png(data)
        blurred_display = blurred_mask_png(normalized_binary, blur)
        return self._write_normalized(relative, normalized_binary, blurred_display, blur)

    def write_generated(
        self,
        relative: Path,
        data: bytes,
        blur: int,
    ) -> dict[str, bool | int | str | None]:
        try:
            with Image.open(self._root / relative) as source:
                source_size = source.size
        except (OSError, UnidentifiedImageError) as error:
            raise HTTPException(422, "source image could not be read") from error
        normalized_binary = normalize_png(data, expected_dimensions=source_size)
        blurred_display = blurred_mask_png(normalized_binary, blur)
        return self._write_normalized(relative, normalized_binary, blurred_display, blur)

    def _write_normalized(
        self,
        relative: Path,
        normalized_binary: bytes,
        blurred_display: bytes,
        blur: int,
    ) -> dict[str, bool | int | str | None]:
        updated_at = datetime.now(timezone.utc).isoformat()
        metadata = {
            "path": relative_text(relative),
            "blur": blur,
            "updated_at": updated_at,
        }
        with self._lock:
            self._ensure_directory()
            previous_metadata = self._load_metadata(relative)
            binary_path, display_path, metadata_path = self._paths(relative)
            try:
                previous_binary_data = binary_path.read_bytes() if previous_metadata else None
                previous_display_data = display_path.read_bytes() if display_path.exists() else None
            except OSError as error:
                raise HTTPException(500, "mask storage could not be read") from error
            binary_temp = self._temporary_path(binary_path)
            display_temp = self._temporary_path(display_path)
            metadata_temp = self._temporary_path(metadata_path)
            binary_replaced = False
            display_replaced = False
            try:
                self._write_file(binary_temp, normalized_binary)
                self._write_file(display_temp, blurred_display)
                self._write_file(metadata_temp, json.dumps(metadata, separators=(",", ":")).encode("utf-8"))
                os.replace(binary_temp, binary_path)
                binary_replaced = True
                os.replace(display_temp, display_path)
                display_replaced = True
                os.replace(metadata_temp, metadata_path)
            except OSError as error:
                self._cleanup_temps(binary_temp, display_temp, metadata_temp)
                if display_replaced:
                    try:
                        if previous_display_data is None:
                            display_path.unlink()
                        else:
                            self._restore_file(display_path, previous_display_data)
                    except OSError as rollback_error:
                        raise HTTPException(
                            500,
                            "mask storage update failed and could not be rolled back",
                        ) from rollback_error
                if binary_replaced:
                    try:
                        if previous_binary_data is None:
                            binary_path.unlink()
                        else:
                            self._restore_file(binary_path, previous_binary_data)
                    except OSError as rollback_error:
                        raise HTTPException(
                            500,
                            "mask storage update failed and could not be rolled back",
                        ) from rollback_error
                raise HTTPException(500, "mask storage could not be updated") from error
            return self._info(relative, metadata)

    def delete(self, relative: Path) -> dict[str, bool | int | str | None]:
        with self._lock:
            metadata = self._load_metadata(relative)
            if metadata is None:
                return self._info(relative, None)
            binary_path, display_path, metadata_path = self._paths(relative)
            try:
                binary_data = binary_path.read_bytes()
                display_data = display_path.read_bytes() if display_path.exists() else None
                metadata_data = metadata_path.read_bytes()
                binary_path.unlink()
                if display_path.exists():
                    display_path.unlink()
                metadata_path.unlink()
            except OSError as error:
                try:
                    if not binary_path.exists() and "binary_data" in locals():
                        self._restore_file(binary_path, binary_data)
                    if not display_path.exists() and "display_data" in locals() and display_data is not None:
                        self._restore_file(display_path, display_data)
                    if not metadata_path.exists() and "metadata_data" in locals():
                        self._restore_file(metadata_path, metadata_data)
                except OSError as rollback_error:
                    raise HTTPException(
                        500,
                        "mask storage deletion failed and could not be rolled back",
                    ) from rollback_error
                raise HTTPException(500, "mask storage could not be deleted") from error
            return self._info(relative, None)

    def _paths(self, relative: Path) -> tuple[Path, Path, Path]:
        digest = hashlib.sha256(relative_text(relative).encode("utf-8")).hexdigest()
        return (
            self._directory / f"{digest}.png",
            self._directory / f"{digest}.display.png",
            self._directory / f"{digest}.json",
        )

    def _ensure_directory(self) -> None:
        if self._directory.is_symlink() or (self._directory.exists() and not self._directory.is_dir()):
            raise HTTPException(500, "mask storage directory is invalid")
        try:
            self._directory.mkdir(mode=0o700, exist_ok=True)
        except OSError as error:
            raise HTTPException(500, "mask storage directory could not be created") from error

    def _temporary_path(self, destination: Path) -> Path:
        temporary = self._directory / f".{destination.name}.{uuid.uuid4().hex}.tmp"
        try:
            temporary.relative_to(self._directory)
        except ValueError as error:
            raise HTTPException(500, "mask temporary path is invalid") from error
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

    def _load_metadata(self, relative: Path) -> dict[str, int | str] | None:
        binary_path, display_path, metadata_path = self._paths(relative)
        if binary_path.is_symlink() or display_path.is_symlink() or metadata_path.is_symlink():
            raise HTTPException(500, "mask storage is invalid")
        mask_exists = binary_path.exists()
        metadata_exists = metadata_path.exists()
        if mask_exists != metadata_exists:
            raise HTTPException(500, "mask storage is inconsistent")
        if not mask_exists:
            return None
        if not binary_path.is_file() or not metadata_path.is_file():
            raise HTTPException(500, "mask storage is invalid")
        if display_path.exists() and not display_path.is_file():
            raise HTTPException(500, "mask storage is invalid")
        try:
            loaded = json.loads(metadata_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise HTTPException(500, "mask metadata is malformed") from error
        if not isinstance(loaded, dict):
            raise HTTPException(500, "mask metadata is malformed")
        path = loaded.get("path")
        blur = loaded.get("blur")
        updated_at = loaded.get("updated_at")
        if (
            path != relative_text(relative)
            or isinstance(blur, bool)
            or not isinstance(blur, int)
            or not 0 <= blur <= 64
            or not isinstance(updated_at, str)
        ):
            raise HTTPException(500, "mask metadata is malformed")
        try:
            parsed = datetime.fromisoformat(updated_at)
        except ValueError as error:
            raise HTTPException(500, "mask metadata is malformed") from error
        if parsed.tzinfo is None:
            raise HTTPException(500, "mask metadata is malformed")
        return {"path": path, "blur": blur, "updated_at": updated_at}

    @staticmethod
    def _info(relative: Path, metadata: dict[str, int | str] | None) -> dict[str, bool | int | str | None]:
        if metadata is None:
            return {
                "exists": False,
                "path": relative_text(relative),
                "blur": 0,
                "updated_at": None,
                "url": None,
            }
        return {
            "exists": True,
            "path": relative_text(relative),
            "blur": metadata["blur"],
            "updated_at": metadata["updated_at"],
            "url": media_url(relative, "/api/mask"),
        }


def normalize_png(
    data: bytes,
    *,
    expected_dimensions: tuple[int, int] | None = None,
) -> bytes:
    if not data:
        raise HTTPException(422, "mask PNG must not be empty")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(data)) as verified:
                if verified.format != "PNG":
                    raise HTTPException(422, "mask body must be a PNG")
                verified.verify()
            with Image.open(BytesIO(data)) as image:
                if image.format != "PNG":
                    raise HTTPException(422, "mask body must be a PNG")
                width, height = image.size
                if expected_dimensions is not None and (width, height) != expected_dimensions:
                    raise HTTPException(422, "generated mask dimensions must match the source image")
                if (
                    expected_dimensions is None
                    and (not 0 < width <= MAX_MASK_DIMENSION or not 0 < height <= MAX_MASK_DIMENSION)
                ):
                    raise HTTPException(422, "mask dimensions must not exceed 2048 pixels")
                image.load()
                rgba = image.convert("RGBA")
                alpha = rgba.getchannel("A").point(lambda value: 255 if value >= 128 else 0, mode="L")
                binary_rgba = Image.new("RGBA", rgba.size, (255, 255, 255, 0))
                binary_rgba.putalpha(alpha)
                output = BytesIO()
                binary_rgba.save(output, format="PNG")
                return output.getvalue()
    except (UnidentifiedImageError, OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise HTTPException(422, "mask body must be a valid PNG") from error


def blurred_mask_png(binary_png: bytes, blur: int) -> bytes:
    try:
        with Image.open(BytesIO(binary_png)) as image:
            rgba = image.convert("RGBA")
    except (UnidentifiedImageError, OSError, SyntaxError) as error:
        raise HTTPException(500, "mask storage is invalid") from error
    alpha = rgba.getchannel("A")
    blurred_alpha = alpha if blur <= 0 else alpha.filter(ImageFilter.GaussianBlur(blur))
    blurred_rgba = Image.new("RGBA", rgba.size, (255, 255, 255, 0))
    blurred_rgba.putalpha(blurred_alpha)
    output = BytesIO()
    blurred_rgba.save(output, format="PNG")
    return output.getvalue()
